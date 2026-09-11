/**
 * Transcription clients.
 *
 * LiveDictation talks to our own /api/dictate/* routes, which hold the API key
 * and bridge to the Dictation endpoint. Two upload strategies:
 *
 *   streaming  The request opens the moment speech is detected and PCM goes up
 *              as it is captured. The endpoint transcribes while the audio is
 *              still arriving, so when the speaker stops, the only thing left
 *              to process is the tail. This is the point of the whole API.
 *
 *   buffered   The clip is encoded to WAV and posted in one go once the
 *              utterance closes. This is the fallback, and the control in the
 *              A/B comparison that shows what streaming is actually worth.
 *
 * DemoDictation replays a scripted document with realistic latencies and both
 * the verbatim and rewritten text, so the repo is explorable with no key and no
 * microphone.
 */

import { KEYTERMS, STT_PROMPT } from "./commands.js";

export class LiveDictation {
  constructor() {
    this.mode = "live";
  }

  buildConfig({ language = "en", llmInstruction = "" } = {}) {
    const config = {
      language_codes: [language],
      keyterms_prompt: KEYTERMS,
      stt_prompt: STT_PROMPT,
    };
    // Omitting llm_instruction keeps AssemblyAI's default cleanup, which is
    // exactly the behaviour we want, so only send it when overridden.
    if (llmInstruction && llmInstruction.trim()) {
      config.llm_instruction = llmInstruction.trim();
    }
    return config;
  }

  /**
   * Open an upstream request and return a handle for this utterance alone.
   *
   * Per-utterance state rather than fields on the client, because utterances
   * overlap: the previous one can still be awaiting its transcript when the
   * speaker starts the next. Shared mutable state here would let the new
   * utterance clobber the finishing one's session id and byte counters.
   */
  async startUtterance(options = {}) {
    const response = await fetch("api/dictate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildConfig(options)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw toError(payload, response);

    return new Utterance(payload.sessionId);
  }

  /** Whole-clip upload. Fallback, and the control in the A/B comparison. */
  async transcribeBuffered(wavBlob, options = {}) {
    const config = encodeURIComponent(JSON.stringify(this.buildConfig(options)));
    const waitFrom = performance.now();

    const response = await fetch(`api/transcribe?config=${config}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBlob,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw toError(payload, response);

    payload._speakdown = {
      ...payload._speakdown,
      waitAfterSpeechMs: Math.round(performance.now() - waitFrom),
      sentBytes: wavBlob.size,
    };
    return payload;
  }
}

/** One in-flight streaming utterance. */
class Utterance {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.openedAt = performance.now();
    this.sentBytes = 0;
    this.closed = false;
    /**
     * Chunk POSTs must reach the server in the order they were captured — the
     * server splices them into one upstream body, so a reordered pair is
     * scrambled audio. Each send is chained onto the last rather than fired in
     * parallel. They are sub-millisecond localhost requests arriving ~120 ms
     * apart, so there is ample headroom.
     */
    this.sendChain = Promise.resolve();
  }

  /** Queue a slab of PCM. Non-blocking; ordering is preserved by the chain. */
  send(pcmBytes) {
    if (this.closed || !pcmBytes?.length) return;
    this.sentBytes += pcmBytes.length;

    this.sendChain = this.sendChain
      .then(() => {
        if (this.closed) return null;
        return fetch(`api/dictate/chunk?session=${encodeURIComponent(this.sessionId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: pcmBytes,
        });
      })
      .catch((err) => {
        console.warn("[speakdown] chunk upload failed:", err);
      });
  }

  /** Close the body and wait for the transcript. */
  async end() {
    if (this.closed) return null;

    // Everything queued must land before the body is closed.
    await this.sendChain;
    this.closed = true;

    const uploadHeldMs = Math.round(performance.now() - this.openedAt);
    const waitFrom = performance.now();

    const response = await fetch(
      `api/dictate/end?session=${encodeURIComponent(this.sessionId)}`,
      { method: "POST" },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw toError(payload, response);

    payload._speakdown = {
      ...payload._speakdown,
      // The number that matters to a person: how long they waited AFTER they
      // stopped talking. Streaming is what makes this smaller than the clip.
      waitAfterSpeechMs: Math.round(performance.now() - waitFrom),
      uploadHeldMs,
      sentBytes: this.sentBytes,
    };
    return payload;
  }

  async abort() {
    if (this.closed) return;
    this.closed = true;
    try {
      await fetch(`api/dictate/abort?session=${encodeURIComponent(this.sessionId)}`, {
        method: "POST",
      });
    } catch {
      /* the server reaps stale sessions anyway */
    }
  }
}

function toError(payload, response) {
  const err = new Error(payload.message || `Request failed (${response.status})`);
  err.code = payload.error || `http_${response.status}`;
  err.status = response.status;
  err.fatal = payload.fatal || false;
  err.retryAfter = response.headers.get("retry-after");
  return err;
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

/** Words the model plausibly struggles with, so the heatmap has something honest to show. */
const DEMO_LOW_CONFIDENCE = {
  assemblyai: 0.58,
  keyterms: 0.64,
  speakdown: 0.71,
  phoneme: 0.66,
  multipart: 0.69,
  webm: 0.67,
};

/**
 * The scripted demo. Each entry is a `text` (verbatim, disfluencies intact,
 * exactly as the API returns it) and the `llm_response` the default cleanup
 * produces — disfluencies removed, every other word left exactly as spoken.
 * Where they are identical the rewrite had nothing to do, which is also true
 * of real transcripts most of the time.
 */
export const DEMO_SCRIPT = [
  { text: "Title, Speakdown field notes" },
  { text: "Heading two, what this is" },
  {
    text: "Speakdown is a um voice native markdown editor. You dictate the prose and you know you speak the formatting out loud.",
    llm_response: "Speakdown is a voice native markdown editor. You dictate the prose and you speak the formatting out loud.",
  },
  { text: "New paragraph" },
  {
    text: "It runs on the AssemblyAI dictation endpoint, which, uh, returns a finished transcript in a single HTTP call.",
    llm_response: "It runs on the AssemblyAI dictation endpoint, which returns a finished transcript in a single HTTP call.",
  },
  { text: "Heading two, uploading while you speak", llm_response: "Heading two, uploading while you speak" },
  {
    text: "The endpoint transcribes the audio it already has while the rest is still arriving.",
  },
  {
    text: "So Speakdown opens the request the moment it hears you start, and pushes PCM up as it is captured.",
  },
  {
    text: "When you stop talking, the only thing left to process is the tail.",
  },
  { text: "Bold that" },
  { text: "Heading two, why the spoken commands land" },
  {
    text: "Bullet list, every command phrase goes into keyterms prompt on every request",
  },
  {
    text: "Next bullet, so heading two comes back as those two words, not heading too",
  },
  {
    text: "Next bullet, the parser is deterministic, there is, um, no language model in the command loop",
    llm_response: "Next bullet, the parser is deterministic, there is no language model in the command loop",
  },
  {
    text: "Next bullet, three hundred milliseconds of pre roll audio is kept before speech onset so the first phoneme survives",
  },
  { text: "Heading two, the honest bits" },
  {
    text: "Block quote, the rewrite is on by default and removes disfluencies only. The verbatim transcript always comes back alongside it, so you can see exactly what changed.",
  },
  {
    text: "New paragraph, the browser will not hand you sixteen bit audio. MediaRecorder gives you webm opus, which this endpoint rejects with a four fifteen.",
  },
  { text: "Heading two, running it" },
  { text: "Code block" },
  { text: "node server slash index dot js" },
  { text: "End code block" },
  { text: "Divider" },
  { text: "Checklist, record the demo video" },
  { text: "New task, push the repo and submit the form" },
  { text: "This last sentence is a mistake." },
  { text: "Scratch that" },
];

export class DemoDictation {
  constructor() {
    this.mode = "demo";
    this.index = 0;
    this.openedAt = 0;
  }

  get remaining() {
    return DEMO_SCRIPT.length - this.index;
  }

  reset() {
    this.index = 0;
  }

  buildConfig() {
    return { language_codes: ["en"], keyterms_prompt: KEYTERMS, stt_prompt: STT_PROMPT };
  }

  async startUtterance() {
    const entry = DEMO_SCRIPT[this.index];
    const demo = this;
    const openedAt = performance.now();
    return {
      sessionId: `demo-${this.index}`,
      sentBytes: 0,
      closed: false,
      send() {},
      async abort() {
        this.closed = true;
      },
      async end() {
        if (this.closed) return null;
        this.closed = true;
        return demo.#produce(entry, Math.round(performance.now() - openedAt));
      },
    };
  }

  async #produce(entry, uploadHeldMs) {
    if (!entry) return null;
    this.index++;
    const text = entry.text;
    const llmResponse = entry.llm_response ?? text;

    // Transcription of the streamed portion has already happened during
    // speech; what is left is the tail plus the rewrite. Those are the two
    // numbers a real response makes visible, so the demo models them.
    const syncTimeMs = Math.round(90 + Math.random() * 60);
    const rewriteMs = Math.round(210 + Math.random() * 180);
    const requestTimeMs = syncTimeMs + rewriteMs;
    const waitAfterSpeechMs = Math.round(requestTimeMs * 0.45 + 40 + Math.random() * 30);

    await sleep(waitAfterSpeechMs);

    const words = text.split(/\s+/).map((token) => {
      const bare = token.toLowerCase().replace(/^\W+|\W+$/g, "");
      const confidence = DEMO_LOW_CONFIDENCE[bare] ?? round(0.93 + Math.random() * 0.069);
      return { text: token, confidence };
    });

    return {
      text,
      llm_response: llmResponse,
      llm_error: null,
      words,
      confidence: round(words.reduce((a, w) => a + w.confidence, 0) / (words.length || 1)),
      audio_duration_ms: Math.round(words.length * 320 + 400),
      session_id: `demo-${this.index}`,
      request_time_ms: requestTimeMs,
      sync_time_ms: syncTimeMs,
      _speakdown: {
        mode: "streaming",
        roundTripMs: requestTimeMs,
        rewriteMs,
        waitAfterSpeechMs,
        uploadHeldMs,
        chunks: Math.max(1, Math.round(words.length / 3)),
        sentBytes: Math.round((words.length * 320 + 400) * 32),
        demo: true,
      },
    };
  }

  async transcribeBuffered() {
    const handle = await this.startUtterance();
    return handle.end();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
