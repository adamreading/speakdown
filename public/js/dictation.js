/**
 * Transcription clients.
 *
 * LiveDictation posts WAV clips to our own /api/transcribe, which attaches the
 * API key and forwards to the AssemblyAI Sync endpoint. The key never reaches
 * the browser.
 *
 * DemoDictation replays a scripted document with realistic latencies and word
 * confidences. It exists so the repo is explorable with no key and no
 * microphone — clone, `node server/index.js`, press Play, and the whole editor
 * behaves exactly as it does live.
 */

import { KEYTERMS, DICTATION_PROMPT } from "./commands.js";

/** How many previous utterances to send as `conversation_context`. */
const CONTEXT_TURNS = 8;

export class LiveDictation {
  constructor() {
    this.mode = "live";
    this.context = [];
  }

  /**
   * @param {Blob} blob 16-bit WAV
   * @param {object} options
   * @param {string} options.language
   * @returns {Promise<object>} upstream JSON plus `_speakdown` timings
   */
  async transcribe(blob, { language = "en" } = {}) {
    const params = new URLSearchParams({
      language,
      timestamps: "1",
      keyterms: JSON.stringify(KEYTERMS),
      prompt: DICTATION_PROMPT,
    });
    if (this.context.length) {
      params.set("context", JSON.stringify(this.context.slice(-CONTEXT_TURNS)));
    }

    const response = await fetch(`/api/transcribe?${params}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: blob,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(payload.message || `Transcription failed (${response.status})`);
      err.code = payload.error || `http_${response.status}`;
      err.status = response.status;
      err.retryAfter = response.headers.get("retry-after");
      throw err;
    }
    return payload;
  }

  /**
   * Keep the rolling context window. Sent on subsequent requests so the model
   * holds terminology and proper nouns steady across a document rather than
   * treating every utterance as a cold start.
   */
  pushContext(text) {
    if (!text || !text.trim()) return;
    this.context.push(text.trim());
    if (this.context.length > CONTEXT_TURNS * 2) {
      this.context = this.context.slice(-CONTEXT_TURNS);
    }
  }

  resetContext() {
    this.context = [];
  }
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

/**
 * Words the model plausibly struggles with, so the confidence heatmap has
 * something honest to show in the demo.
 */
const DEMO_LOW_CONFIDENCE = {
  assemblyai: 0.58,
  keyterms: 0.64,
  "speakdown": 0.71,
  phoneme: 0.66,
  deterministic: 0.73,
  webm: 0.69,
};

/**
 * The scripted demo. Each entry is one utterance exactly as the API would
 * return it — commands included, fillers included, because that is what real
 * transcripts look like.
 */
export const DEMO_SCRIPT = [
  "Title, Speakdown field notes",
  "Heading two, what this is",
  "Speakdown is a um voice native markdown editor. You dictate the prose and you speak the formatting out loud.",
  "New paragraph",
  "It runs on the AssemblyAI sync dictation endpoint, which returns a finished transcript in a single HTTP round trip. You know, no websocket, no polling, no job to manage.",
  "Heading two, why the spoken commands actually land",
  "Bullet list, every command phrase is pushed into keyterms prompt on every request",
  "Next bullet, so heading two comes back as those two words, not heading too",
  "Next bullet, the parser is deterministic, there is no language model in the command loop",
  "Next bullet, three hundred milliseconds of pre roll audio is kept before speech onset so the first phoneme survives",
  "Heading two, the honest bits",
  "Block quote, filler removal happens in this client, not at the API. The hackathon brief advertises it, the Sync API reference does not document it.",
  "New paragraph, the browser will not hand you sixteen bit audio. MediaRecorder gives you webm opus, so Speakdown captures raw float frames through an audio worklet and encodes the WAV itself.",
  "That is the part everyone gets wrong.",
  "Bold that",
  "Heading two, running it",
  "Code block",
  "node server slash index dot js",
  "End code block",
  "Divider",
  "Checklist, record the demo video",
  "New task, push the repo and submit the form",
  "New task, file the docs inconsistency as API feedback",
  "This last sentence is a mistake.",
  "Scratch that",
];

export class DemoDictation {
  constructor() {
    this.mode = "demo";
    this.index = 0;
    this.context = [];
  }

  get remaining() {
    return DEMO_SCRIPT.length - this.index;
  }

  get progress() {
    return DEMO_SCRIPT.length ? this.index / DEMO_SCRIPT.length : 1;
  }

  reset() {
    this.index = 0;
    this.context = [];
  }

  /** Next scripted utterance, shaped like a real API response. */
  async transcribe() {
    if (this.index >= DEMO_SCRIPT.length) return null;
    const text = DEMO_SCRIPT[this.index++];

    // Plausible p50-ish server time, with jitter.
    const requestTimeMs = Math.round(110 + Math.random() * 70);
    const networkMs = Math.round(18 + Math.random() * 35);
    await sleep(requestTimeMs + networkMs);

    const words = text.split(/\s+/).map((token) => {
      const bare = token.toLowerCase().replace(/^\W+|\W+$/g, "");
      const confidence = DEMO_LOW_CONFIDENCE[bare] ?? round(0.93 + Math.random() * 0.069);
      return { text: token, confidence };
    });

    const overall = words.reduce((acc, w) => acc + w.confidence, 0) / (words.length || 1);

    return {
      text,
      words,
      confidence: round(overall),
      audio_duration_ms: Math.round(words.length * 320 + 400),
      session_id: `demo-${this.index}`,
      request_time_ms: requestTimeMs,
      _speakdown: {
        roundTripMs: requestTimeMs + networkMs,
        networkMs,
        sentBytes: Math.round((words.length * 320 + 400) * 32), // 16 kHz mono 16-bit
        language: "en",
        keytermCount: KEYTERMS.length,
        contextTurns: Math.min(this.context.length, CONTEXT_TURNS),
        demo: true,
      },
    };
  }

  pushContext(text) {
    if (text?.trim()) this.context.push(text.trim());
  }

  resetContext() {
    this.context = [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

export { CONTEXT_TURNS };
