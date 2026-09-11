/**
 * The AssemblyAI Dictation API client.
 *
 * Endpoint: POST https://dictation.assemblyai.com/v1/transcribe/live
 *
 * Two things about this API drive the whole design:
 *
 *   1. The multipart body must carry `config` BEFORE `audio`. The server starts
 *      transcribing as the audio arrives and cannot begin without the config,
 *      so a body in the wrong order is rejected with 400. That is why the body
 *      is assembled by hand here rather than with FormData, which gives no
 *      ordering guarantee and buffers the whole thing anyway.
 *
 *   2. The endpoint reads the body as it arrives. If you open the request when
 *      the speaker starts talking and push frames up as they are captured, the
 *      transcription happens *during* the utterance, and when the speaker stops
 *      they only wait for the tail. This is the capability the whole product is
 *      built around, and it is why `openStream` exists alongside `transcribe`.
 *
 * Raw PCM (audio/pcm) is used for the streaming path because it needs no
 * container header — there is no length to backfill, so frames can go up the
 * moment they exist. The buffered path sends WAV.
 */

const BOUNDARY = "----speakdown-dictation-boundary";

/** Config fields the API accepts. Anything else is forwarded as-is by them. */
const CONFIG_FIELDS = new Set([
  "sample_rate",
  "channels",
  "language_codes",
  "stt_prompt",
  "keyterms_prompt",
  "llm_instruction",
]);

/** The 19 language codes the Dictation API accepts. */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "tr", label: "Turkish" },
  { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" },
  { code: "no", label: "Norwegian" },
  { code: "da", label: "Danish" },
  { code: "fi", label: "Finnish" },
  { code: "hi", label: "Hindi" },
  { code: "vi", label: "Vietnamese" },
  { code: "ar", label: "Arabic" },
  { code: "he", label: "Hebrew" },
  { code: "ja", label: "Japanese" },
  { code: "ur", label: "Urdu" },
  { code: "zh", label: "Mandarin" },
];

export const LIMITS = {
  maxAudioSeconds: 120,
  maxSttPromptChars: 4096,
  maxKeytermsChars: 2048,
  maxLlmInstructionChars: 2048,
  /** 120 s of 16 kHz mono 16-bit PCM, plus headroom. */
  maxAudioBytes: 120 * 16000 * 2 + 1024,
  /** The docs ask for a 90 s client timeout. */
  timeoutMs: 90_000,
};

/** Build the leading bytes of the body: the config part and the audio headers. */
function multipartHead(config, audioContentType) {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="config"\r\n' +
      "Content-Type: application/json\r\n\r\n" +
      `${JSON.stringify(config)}\r\n` +
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="audio"; filename="audio"\r\n' +
      `Content-Type: ${audioContentType}\r\n\r\n`,
  );
}

function multipartTail() {
  return Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
}

/**
 * Normalise and clamp a config object to what the API documents.
 * Unknown keys are dropped rather than forwarded, so a client cannot smuggle
 * arbitrary fields through this proxy.
 */
export function sanitiseConfig(input = {}) {
  const config = {};

  for (const [key, value] of Object.entries(input)) {
    if (!CONFIG_FIELDS.has(key) || value == null) continue;
    config[key] = value;
  }

  if (config.language_codes) {
    const codes = (Array.isArray(config.language_codes) ? config.language_codes : [config.language_codes])
      .map(String)
      .filter((code) => LANGUAGES.some((l) => l.code === code));
    config.language_codes = codes.length ? codes : ["en"];
  }

  if (config.keyterms_prompt) {
    const terms = Array.isArray(config.keyterms_prompt)
      ? config.keyterms_prompt
      : [config.keyterms_prompt];
    const kept = [];
    let used = 0;
    for (const term of terms) {
      const t = String(term).trim();
      if (!t) continue;
      if (used + t.length + 1 > LIMITS.maxKeytermsChars) break;
      kept.push(t);
      used += t.length + 1;
    }
    if (kept.length) config.keyterms_prompt = kept;
    else delete config.keyterms_prompt;
  }

  if (config.stt_prompt) {
    config.stt_prompt = String(config.stt_prompt).slice(0, LIMITS.maxSttPromptChars);
  }

  // Omitting llm_instruction keeps the default cleanup, which is what we want
  // by default — so an empty string means "omit", not "rewrite into nothing".
  if (config.llm_instruction != null) {
    const instruction = String(config.llm_instruction).trim();
    if (instruction) config.llm_instruction = instruction.slice(0, LIMITS.maxLlmInstructionChars);
    else delete config.llm_instruction;
  }

  for (const numeric of ["sample_rate", "channels"]) {
    if (config[numeric] != null) config[numeric] = Number(config[numeric]);
  }

  return config;
}

/**
 * Map an upstream failure onto something the UI can act on.
 * Note 404: the Dictation API returns it for an invalid key, not 401.
 */
export function describeError(status, payload) {
  const code = payload?.error_code || payload?.error || null;

  if (status === 404) {
    return {
      error: "invalid_api_key",
      message:
        "AssemblyAI rejected the API key (this endpoint returns 404 for a bad key). " +
        "Check ASSEMBLYAI_API_KEY in .env and restart.",
      fatal: true,
    };
  }
  if (status === 401) {
    return { error: "no_credential", message: "No API key was sent upstream.", fatal: true };
  }
  if (status === 415) {
    return {
      error: "unsupported_media_type",
      message: "Audio must be WAV or raw 16-bit PCM. Compressed formats are rejected.",
    };
  }
  if (status === 413) {
    return { error: "audio_too_large", message: "Audio exceeded the size cap (120 s maximum)." };
  }
  if (status === 429) {
    return { error: "rate_limited", message: "Rate limited by AssemblyAI. Backing off." };
  }
  if (status === 503) {
    return { error: "capacity_exceeded", message: "AssemblyAI is at capacity. Retrying later." };
  }
  if (status === 502 || status === 504) {
    return { error: "upstream_unavailable", message: "Transcription upstream timed out." };
  }
  if (status === 400) {
    return {
      error: code || "bad_request",
      message: payload?.error || payload?.detail || "The request was rejected as malformed.",
    };
  }
  return {
    error: code || `upstream_${status}`,
    message: payload?.error || payload?.detail || `AssemblyAI returned ${status}.`,
  };
}

/**
 * Buffered call: the whole clip is already in hand.
 * Used for the fallback path and for the side-by-side latency comparison.
 */
export async function transcribeBuffered({ apiKey, url, config, audio, contentType = "audio/wav" }) {
  const body = Buffer.concat([multipartHead(config, contentType), audio, multipartTail()]);

  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      "Content-Length": String(body.length),
    },
    body,
    signal: AbortSignal.timeout(LIMITS.timeoutMs),
  });

  return finish(response, startedAt, audio.length);
}

/**
 * Streaming call: open the request now, push frames as they are captured.
 *
 * Returns a handle with `write(chunk)`, `end()` and `abort()`. The upstream
 * request is already in flight by the time this returns, so the config part has
 * left the machine before the speaker has finished their first word.
 */
export function openStream({ apiKey, url, config, contentType = "audio/pcm" }) {
  let controller = null;
  let closed = false;
  let bytes = 0;

  const body = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(multipartHead(config, contentType));
    },
    cancel() {
      closed = true;
    },
  });

  const startedAt = performance.now();
  const responsePromise = fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    body,
    duplex: "half", // required whenever the body is a stream
    signal: AbortSignal.timeout(LIMITS.timeoutMs),
  });

  // Without a catch attached now, a connection failure before end() is called
  // surfaces as an unhandled rejection and takes the process down.
  responsePromise.catch(() => {});

  return {
    get bytes() {
      return bytes;
    },
    get closed() {
      return closed;
    },
    write(chunk) {
      if (closed) return false;
      if (bytes + chunk.length > LIMITS.maxAudioBytes) return false;
      controller.enqueue(chunk);
      bytes += chunk.length;
      return true;
    },
    async end() {
      if (!closed) {
        controller.enqueue(multipartTail());
        controller.close();
        closed = true;
      }
      const response = await responsePromise;
      return finish(response, startedAt, bytes);
    },
    abort() {
      if (closed) return;
      closed = true;
      try {
        controller.error(new Error("aborted"));
      } catch {
        /* already gone */
      }
    },
  };
}

async function finish(response, startedAt, sentBytes) {
  const roundTripMs = Math.round(performance.now() - startedAt);
  const raw = await response.text();

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { error: "bad_upstream_response", detail: raw.slice(0, 500) };
  }

  if (!response.ok) {
    const described = describeError(response.status, payload);
    const err = new Error(described.message);
    err.status = response.status;
    err.code = described.error;
    err.fatal = described.fatal || false;
    err.retryAfter = response.headers.get("retry-after");
    err.roundTripMs = roundTripMs;
    throw err;
  }

  payload._speakdown = {
    roundTripMs,
    sentBytes,
    // request_time_ms is the whole server-side cost; sync_time_ms is just the
    // transcription part. The difference is essentially the LLM rewrite.
    rewriteMs:
      typeof payload.request_time_ms === "number" && typeof payload.sync_time_ms === "number"
        ? Math.max(0, payload.request_time_ms - payload.sync_time_ms)
        : null,
  };

  return payload;
}

export { BOUNDARY };
