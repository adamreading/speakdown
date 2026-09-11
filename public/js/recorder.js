/**
 * Microphone capture with voice-activity segmentation.
 *
 * The Sync API takes a discrete clip and returns a transcript in one round
 * trip. So the interesting problem is not streaming — it is deciding where one
 * utterance ends and the next begins, and doing it fast enough that dictation
 * feels continuous.
 *
 * The segmenter here is a two-state machine over frame energy, with three
 * details that matter more than the algorithm choice:
 *
 *   1. Pre-roll. We retain ~300 ms of audio from *before* speech was detected.
 *      Without it every utterance loses its first consonant, and "bullet list"
 *      arrives as "ullet list".
 *   2. Adaptive noise floor. A fixed threshold works in a quiet room and fails
 *      on a laptop fan. The floor tracks ambient level and the speech threshold
 *      floats above it.
 *   3. Hysteresis. Speech onset and offset use different thresholds, so a brief
 *      dip mid-word does not split an utterance in two.
 */

import { framesToWav, rms } from "./wav.js";

const DEFAULTS = {
  /** Frame energy must exceed the threshold for this long to open an utterance. */
  onsetMs: 120,
  /** Silence for this long closes the utterance. Tune down for snappier, up for fewer splits. */
  hangoverMs: 700,
  /** Audio retained from before onset, so the first phoneme survives. */
  prerollMs: 300,
  /** Force a flush here. Well under the API's 120 s ceiling. */
  maxUtteranceMs: 20_000,
  /** Shorter than this is a click, a breath or a door — not worth a request. */
  minUtteranceMs: 250,
  /** Absolute floor, so a silent room cannot drive the threshold to zero. */
  minThreshold: 0.008,
  /** Speech threshold = noiseFloor * this. */
  thresholdFactor: 3.5,
  /** Offset threshold as a fraction of onset threshold (hysteresis). */
  releaseRatio: 0.6,
};

export const RecorderState = {
  IDLE: "idle",
  LISTENING: "listening",
  SPEAKING: "speaking",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
};

export class Recorder {
  /**
   * @param {object} handlers
   * @param {(u: {blob: Blob, durationMs: number, sampleCount: number, trigger: string}) => void} handlers.onUtterance
   * @param {(level: number, threshold: number) => void} [handlers.onLevel]
   * @param {(state: string, detail?: any) => void} [handlers.onState]
   * @param {object} [options]
   */
  constructor(handlers = {}, options = {}) {
    this.onUtterance = handlers.onUtterance || (() => {});
    this.onLevel = handlers.onLevel || (() => {});
    this.onState = handlers.onState || (() => {});
    this.opts = { ...DEFAULTS, ...options };

    this.mode = "vad"; // 'vad' | 'ptt'
    this.state = RecorderState.IDLE;

    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.sampleRate = 16000;

    // Segmenter state
    this.speaking = false;
    this.frames = [];
    this.preroll = [];
    this.prerollSamples = 0;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.utteranceMs = 0;
    this.noiseFloor = 0.01;
    this.pttActive = false;
  }

  get isRunning() {
    return this.ctx !== null;
  }

  /** Request the mic and build the audio graph. Resolves once frames are flowing. */
  async start() {
    if (this.ctx) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.#setState(RecorderState.UNSUPPORTED, {
        reason: "getUserMedia unavailable. Serve over http://localhost or https://.",
      });
      throw new Error("getUserMedia unavailable");
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Let the browser do the boring parts well.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      this.#setState(RecorderState.DENIED, { reason: err?.message || String(err) });
      throw err;
    }

    // Ask for 16 kHz directly. Where the browser honours it we skip resampling
    // altogether; where it does not, wav.js resamples on the way out.
    try {
      this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    } catch {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;

    this.source = this.ctx.createMediaStreamSource(this.stream);
    await this.#buildCaptureNode();

    this.#resetSegmenter();
    this.#setState(RecorderState.LISTENING);
  }

  /** Tear down the graph and release the mic indicator. */
  async stop() {
    if (this.speaking) this.#flush("stop");
    if (this.node) {
      try {
        this.node.disconnect();
        if (this.node.port) this.node.port.onmessage = null;
        this.node.onaudioprocess = null;
      } catch {
        /* already gone */
      }
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* already closed */
      }
    }
    this.ctx = this.stream = this.node = this.source = null;
    this.#resetSegmenter();
    this.#setState(RecorderState.IDLE);
  }

  setMode(mode) {
    if (mode !== "vad" && mode !== "ptt") return;
    if (this.speaking) this.#flush("mode-change");
    this.mode = mode;
    this.#resetSegmenter();
  }

  /** Push-to-talk: begin capturing regardless of energy. */
  pttDown() {
    if (this.mode !== "ptt" || !this.ctx) return;
    this.pttActive = true;
    this.speaking = true;
    this.utteranceMs = 0;
    // Seed with pre-roll so the key press does not clip the first word.
    this.frames = this.preroll.slice();
    this.preroll = [];
    this.prerollSamples = 0;
    this.#setState(RecorderState.SPEAKING);
  }

  /** Push-to-talk released: flush whatever was captured. */
  pttUp() {
    if (this.mode !== "ptt" || !this.pttActive) return;
    this.pttActive = false;
    this.#flush("ptt");
    this.#setState(RecorderState.LISTENING);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #buildCaptureNode() {
    const frameHandler = (frame) => this.#onFrame(frame);

    if (this.ctx.audioWorklet) {
      try {
        await this.ctx.audioWorklet.addModule("/js/capture-worklet.js");
        const node = new AudioWorkletNode(this.ctx, "speakdown-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        node.port.onmessage = (event) => frameHandler(event.data);
        this.source.connect(node);
        this.node = node;
        return;
      } catch (err) {
        console.warn("[speakdown] AudioWorklet unavailable, falling back:", err);
      }
    }

    // Fallback for older browsers. Deprecated but universally present.
    const node = this.ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (event) => {
      frameHandler(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(node);
    // ScriptProcessor only fires while connected to a destination; a zero gain
    // node keeps it alive without monitoring the mic back through the speakers.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(this.ctx.destination);
    this.node = node;
  }

  #onFrame(frame) {
    const frameMs = (frame.length / this.sampleRate) * 1000;
    const level = rms(frame);

    const onsetThreshold = Math.max(
      this.noiseFloor * this.opts.thresholdFactor,
      this.opts.minThreshold,
    );
    const releaseThreshold = onsetThreshold * this.opts.releaseRatio;

    this.onLevel(level, onsetThreshold);

    // Push-to-talk: no energy gating at all, just accumulate while held.
    if (this.mode === "ptt") {
      if (this.pttActive) {
        this.frames.push(frame);
        this.utteranceMs += frameMs;
        if (this.utteranceMs >= this.opts.maxUtteranceMs) this.#flush("max-length");
      } else {
        this.#pushPreroll(frame);
        // Keep the floor current so the meter reads sensibly.
        this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      }
      return;
    }

    if (!this.speaking) {
      // Track ambient level while idle.
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      this.#pushPreroll(frame);

      if (level > onsetThreshold) {
        this.voicedMs += frameMs;
        if (this.voicedMs >= this.opts.onsetMs) {
          this.speaking = true;
          this.silentMs = 0;
          this.utteranceMs = 0;
          this.frames = this.preroll.slice(); // pre-roll becomes the head of the clip
          this.preroll = [];
          this.prerollSamples = 0;
          this.#setState(RecorderState.SPEAKING);
        }
      } else {
        this.voicedMs = 0;
      }
      return;
    }

    // Mid-utterance.
    this.frames.push(frame);
    this.utteranceMs += frameMs;

    if (level > releaseThreshold) {
      this.silentMs = 0;
    } else {
      this.silentMs += frameMs;
      if (this.silentMs >= this.opts.hangoverMs) {
        this.#flush("pause");
        this.#setState(RecorderState.LISTENING);
        return;
      }
    }

    if (this.utteranceMs >= this.opts.maxUtteranceMs) {
      this.#flush("max-length");
      // Stay in SPEAKING: the person is mid-sentence, we just cut the clip.
      this.speaking = true;
      this.frames = [];
      this.utteranceMs = 0;
      this.silentMs = 0;
    }
  }

  #pushPreroll(frame) {
    const maxSamples = (this.opts.prerollMs / 1000) * this.sampleRate;
    this.preroll.push(frame);
    this.prerollSamples += frame.length;
    while (this.prerollSamples > maxSamples && this.preroll.length > 1) {
      this.prerollSamples -= this.preroll.shift().length;
    }
  }

  #flush(trigger) {
    const frames = this.frames;
    this.frames = [];
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    const capturedMs = this.utteranceMs;
    this.utteranceMs = 0;

    if (!frames.length) return;

    // Trailing hangover silence is dead weight in the upload; trim most of it.
    const trimmed = this.#trimTrailingSilence(frames, trigger);
    const result = framesToWav(trimmed, this.sampleRate);

    if (result.durationMs < this.opts.minUtteranceMs) return;

    this.onUtterance({ ...result, trigger, capturedMs });
  }

  #trimTrailingSilence(frames, trigger) {
    if (trigger !== "pause") return frames;
    // Keep 150 ms of the hangover as natural decay, drop the rest.
    const keepMs = Math.max(0, this.opts.hangoverMs - 150);
    const dropSamples = (keepMs / 1000) * this.sampleRate;
    let dropped = 0;
    const out = frames.slice();
    while (out.length > 1 && dropped + out[out.length - 1].length <= dropSamples) {
      dropped += out.pop().length;
    }
    return out;
  }

  #resetSegmenter() {
    this.speaking = false;
    this.pttActive = false;
    this.frames = [];
    this.preroll = [];
    this.prerollSamples = 0;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.utteranceMs = 0;
    this.noiseFloor = 0.01;
  }

  #setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }
}
