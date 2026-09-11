/**
 * Microphone capture with voice-activity segmentation.
 *
 * The Dictation API transcribes audio as it arrives, so the goal here is not
 * just "cut the audio into utterances" — it is to know that speech has STARTED
 * as early as possible, so the upload can open and frames can begin flowing
 * while the person is still talking. What they wait for when they stop is then
 * only the tail of the clip.
 *
 * That shapes the event surface: this emits `onSpeechStart` the instant the
 * segmenter opens an utterance, `onAudio` repeatedly with PCM as it is
 * captured, and `onSpeechEnd` when silence closes it.
 *
 * Three details matter more than the VAD algorithm itself:
 *
 *   1. Pre-roll. ~300 ms of audio from *before* speech was detected is retained
 *      and flushed as the first chunk. Without it every utterance loses its
 *      first consonant and "bullet list" arrives as "ullet list".
 *   2. Adaptive noise floor. A fixed threshold works in a quiet room and fails
 *      next to a laptop fan, so the threshold floats above measured ambience.
 *   3. Hysteresis. Onset and offset use different thresholds, so a dip mid-word
 *      does not split one utterance into two.
 */

import { framesToWav, floatToPcmBytes, rms, StreamingResampler, TARGET_SAMPLE_RATE } from "./wav.js";

const DEFAULTS = {
  /** Frame energy must exceed the threshold for this long to open an utterance. */
  onsetMs: 120,
  /** Silence for this long closes it. Down for snappier, up for fewer splits. */
  hangoverMs: 700,
  /** Audio retained from before onset, so the first phoneme survives. */
  prerollMs: 300,
  /** Flush PCM upstream at roughly this cadence while speaking. */
  chunkMs: 120,
  /** Force a close here. The API's hard ceiling is 120 s. */
  maxUtteranceMs: 60_000,
  /** Shorter than this is a click, a breath or a door — not worth a request. */
  minUtteranceMs: 250,
  /** Absolute floor, so a silent room cannot drive the threshold to zero. */
  minThreshold: 0.008,
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
   * @param {() => void} [handlers.onSpeechStart]   Utterance opened — open the upload.
   * @param {(pcm: Uint8Array) => void} [handlers.onAudio]  PCM ready to send.
   * @param {(info: object) => void} [handlers.onSpeechEnd] Utterance closed.
   * @param {(level: number, threshold: number) => void} [handlers.onLevel]
   * @param {(state: string, detail?: any) => void} [handlers.onState]
   * @param {object} [options]
   */
  constructor(handlers = {}, options = {}) {
    this.onSpeechStart = handlers.onSpeechStart || (() => {});
    this.onAudio = handlers.onAudio || (() => {});
    this.onSpeechEnd = handlers.onSpeechEnd || (() => {});
    this.onLevel = handlers.onLevel || (() => {});
    this.onState = handlers.onState || (() => {});
    this.opts = { ...DEFAULTS, ...options };

    this.mode = "vad"; // 'vad' | 'ptt'
    /** Keep every frame so a WAV can be built at the end (buffered mode / A-B). */
    this.keepWav = false;
    this.state = RecorderState.IDLE;

    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.sampleRate = TARGET_SAMPLE_RATE;
    this.resampler = null;

    this.#resetSegmenter();
  }

  get isRunning() {
    return this.ctx !== null;
  }

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

    // Ask for 16 kHz directly. Where the browser honours it there is no
    // resampling at all, which is one less thing between the mic and the wire.
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: "interactive" });
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

  async stop() {
    if (this.speaking) this.#close("stop");
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
    if (this.speaking) this.#close("mode-change");
    this.mode = mode;
    this.#resetSegmenter();
  }

  pttDown() {
    if (this.mode !== "ptt" || !this.ctx || this.speaking) return;
    this.#open();
  }

  pttUp() {
    if (this.mode !== "ptt" || !this.speaking) return;
    this.#close("ptt");
    this.#setState(RecorderState.LISTENING);
  }

  // -------------------------------------------------------------------------

  async #buildCaptureNode() {
    const handle = (frame) => this.#onFrame(frame);

    if (this.ctx.audioWorklet) {
      try {
        await this.ctx.audioWorklet.addModule("/js/capture-worklet.js");
        const node = new AudioWorkletNode(this.ctx, "speakdown-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        node.port.onmessage = (event) => handle(event.data);
        this.source.connect(node);
        this.node = node;
        return;
      } catch (err) {
        console.warn("[speakdown] AudioWorklet unavailable, falling back:", err);
      }
    }

    const node = this.ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (event) => {
      handle(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(node);
    // ScriptProcessor only fires while connected to a destination; a muted gain
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

    if (!this.speaking) {
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      this.#pushPreroll(frame);

      if (this.mode === "ptt") return; // opening is driven by the key, not energy

      if (level > onsetThreshold) {
        this.voicedMs += frameMs;
        if (this.voicedMs >= this.opts.onsetMs) this.#open();
      } else {
        this.voicedMs = 0;
      }
      return;
    }

    // Mid-utterance.
    this.#accumulate(frame);
    this.utteranceMs += frameMs;

    if (this.mode === "vad") {
      if (level > releaseThreshold) {
        this.silentMs = 0;
      } else {
        this.silentMs += frameMs;
        if (this.silentMs >= this.opts.hangoverMs) {
          this.#close("pause");
          this.#setState(RecorderState.LISTENING);
          return;
        }
      }
    }

    if (this.utteranceMs >= this.opts.maxUtteranceMs) {
      this.#close("max-length");
      // The person is mid-sentence; start a fresh utterance immediately.
      this.#open();
    }
  }

  /** Open an utterance: flush pre-roll first, then tell the app to start the upload. */
  #open() {
    this.speaking = true;
    this.silentMs = 0;
    this.voicedMs = 0;
    this.utteranceMs = 0;
    this.pendingSamples = 0;
    this.wavFrames = [];
    this.sentSamples = 0;
    this.resampler = new StreamingResampler(this.sampleRate, TARGET_SAMPLE_RATE);
    this.openedAt = performance.now();

    this.onSpeechStart();
    this.#setState(RecorderState.SPEAKING);

    // The pre-roll is the head of the clip and must go up before live frames.
    const preroll = this.preroll;
    this.preroll = [];
    this.prerollSamples = 0;
    for (const frame of preroll) this.#accumulate(frame, true);
    this.#flush(true);
  }

  #accumulate(frame, prerollOnly = false) {
    if (this.keepWav) this.wavFrames.push(frame);
    const resampled = this.resampler.push(frame);
    if (resampled.length) {
      this.chunkBuffer.push(resampled);
      this.pendingSamples += resampled.length;
    }
    if (!prerollOnly) this.#flush(false);
  }

  /** Send accumulated PCM once we have about `chunkMs` worth. */
  #flush(force) {
    const targetSamples = (this.opts.chunkMs / 1000) * TARGET_SAMPLE_RATE;
    if (!force && this.pendingSamples < targetSamples) return;
    if (!this.pendingSamples) return;

    let total = 0;
    for (const part of this.chunkBuffer) total += part.length;
    const joined = new Float32Array(total);
    let offset = 0;
    for (const part of this.chunkBuffer) {
      joined.set(part, offset);
      offset += part.length;
    }
    this.chunkBuffer = [];
    this.pendingSamples = 0;
    this.sentSamples += joined.length;

    this.onAudio(floatToPcmBytes(joined));
  }

  #close(trigger) {
    if (!this.speaking) return;
    this.speaking = false;

    // Anything the resampler is still holding belongs to this utterance.
    const tail = this.resampler ? this.resampler.flush() : new Float32Array(0);
    if (tail.length) {
      this.chunkBuffer.push(tail);
      this.pendingSamples += tail.length;
    }
    this.#flush(true);

    const durationMs = (this.sentSamples / TARGET_SAMPLE_RATE) * 1000;
    const wav = this.keepWav && this.wavFrames.length
      ? framesToWav(this.wavFrames, this.sampleRate)
      : null;

    this.wavFrames = [];
    this.voicedMs = 0;
    this.silentMs = 0;
    this.utteranceMs = 0;

    this.onSpeechEnd({
      trigger,
      durationMs,
      sampleCount: this.sentSamples,
      tooShort: durationMs < this.opts.minUtteranceMs,
      wav,
      heldMs: performance.now() - this.openedAt,
    });
  }

  #pushPreroll(frame) {
    const maxSamples = (this.opts.prerollMs / 1000) * this.sampleRate;
    this.preroll.push(frame);
    this.prerollSamples += frame.length;
    while (this.prerollSamples > maxSamples && this.preroll.length > 1) {
      this.prerollSamples -= this.preroll.shift().length;
    }
  }

  #resetSegmenter() {
    this.speaking = false;
    this.preroll = [];
    this.prerollSamples = 0;
    this.chunkBuffer = [];
    this.pendingSamples = 0;
    this.wavFrames = [];
    this.sentSamples = 0;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.utteranceMs = 0;
    this.noiseFloor = 0.01;
    this.resampler = null;
    this.openedAt = 0;
  }

  #setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }
}
