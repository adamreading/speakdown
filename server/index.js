/**
 * Speakdown — local server.
 *
 * Two jobs:
 *   1. Serve the static editor from ../public
 *   2. Proxy audio to the AssemblyAI Sync (Dictation) API
 *
 * The proxy exists for one reason: the API key must never reach the browser.
 * The client posts raw 16-bit WAV bytes here, this process attaches the key and
 * builds the multipart request upstream.
 *
 * Zero npm dependencies — node:http, native fetch, FormData and Blob only.
 * Requires Node 20+.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

loadEnvFile(path.join(ROOT, ".env"));

const CONFIG = {
  apiKey: (process.env.ASSEMBLYAI_API_KEY || "").trim(),
  apiUrl: (process.env.SPEAKDOWN_API_URL || "https://sync.assemblyai.com/transcribe").trim(),
  model: (process.env.SPEAKDOWN_MODEL || "universal-3-5-pro").trim(),
  port: Number(process.env.PORT || 3000),
};

/** Hard limits published for the Sync endpoint. We enforce them before burning a request. */
const LIMITS = {
  maxBytes: 40 * 1024 * 1024, // 40 MB
  minDurationMs: 80,
  maxDurationMs: 120_000,
};

/** The 19 language codes the Sync endpoint accepts (docs, Sept 2026). */
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "tr", label: "Turkish" },
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
  ".wav": "audio/wav",
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, {
        mode: CONFIG.apiKey ? "live" : "demo",
        model: CONFIG.model,
        endpoint: CONFIG.apiUrl,
        languages: LANGUAGES,
        limits: LIMITS,
      });
    }

    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      return await handleTranscribe(req, res, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "not_found", message: `No API route ${url.pathname}` });
    }

    return await serveStatic(req, res, url);
  } catch (err) {
    console.error("[speakdown] unhandled error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error", message: String(err?.message || err) });
    }
  }
});

// Only bind a port when run directly (`node server/index.js`). Importing this
// module for tests should not start listening.
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) start();

function start() {
  server.listen(CONFIG.port, () => {
    const mode = CONFIG.apiKey ? "LIVE" : "DEMO (no ASSEMBLYAI_API_KEY set)";
    console.log("");
    console.log("  Speakdown — dictate prose, speak the formatting");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  http://localhost:${CONFIG.port}`);
    console.log(`  mode:     ${mode}`);
    console.log(`  model:    ${CONFIG.model}`);
    console.log(`  endpoint: ${CONFIG.apiUrl}`);
    if (!CONFIG.apiKey) {
      console.log("");
      console.log("  Demo Mode replays a scripted dictation so you can see the whole");
      console.log("  editor without a key. For real dictation:");
      console.log("    cp .env.example .env   # then paste your key into ASSEMBLYAI_API_KEY");
    }
    console.log("");
  });
}

// ---------------------------------------------------------------------------
// /api/transcribe
// ---------------------------------------------------------------------------

/**
 * Body: raw WAV bytes (16-bit PCM).
 * Query: language, keyterms (JSON array), prompt, context (JSON array), timestamps.
 *
 * Returns the upstream JSON plus a `_speakdown` block carrying our own measured
 * round-trip, so the UI can show network cost separately from `request_time_ms`
 * (which is AssemblyAI's server-side processing time only).
 */
async function handleTranscribe(req, res, url) {
  if (!CONFIG.apiKey) {
    return sendJson(res, 503, {
      error: "no_api_key",
      message:
        "No ASSEMBLYAI_API_KEY configured. Copy .env.example to .env and add your key, " +
        "or use Demo Mode in the UI.",
    });
  }

  let audio;
  try {
    audio = await readBody(req, LIMITS.maxBytes);
  } catch (err) {
    if (err.code === "TOO_LARGE") {
      return sendJson(res, 413, {
        error: "audio_too_large",
        message: `Audio exceeds the ${LIMITS.maxBytes / (1024 * 1024)} MB limit.`,
      });
    }
    throw err;
  }

  if (audio.length === 0) {
    return sendJson(res, 400, { error: "bad_audio", message: "Empty request body." });
  }

  // Read the WAV header so we can reject out-of-range audio locally rather than
  // paying for a round trip that is going to fail.
  const wav = describeWav(audio);
  if (wav) {
    if (wav.durationMs < LIMITS.minDurationMs) {
      return sendJson(res, 400, {
        error: "audio_too_short",
        message: `Audio is ${Math.round(wav.durationMs)} ms; the minimum is ${LIMITS.minDurationMs} ms.`,
      });
    }
    if (wav.durationMs > LIMITS.maxDurationMs) {
      return sendJson(res, 400, {
        error: "audio_too_long",
        message: `Audio is ${(wav.durationMs / 1000).toFixed(1)} s; the maximum is ${LIMITS.maxDurationMs / 1000} s.`,
      });
    }
  }

  const config = buildUpstreamConfig(url, wav);

  const form = new FormData();
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "chunk.wav");
  form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }));

  const startedAt = performance.now();
  let upstream;
  try {
    upstream = await fetch(CONFIG.apiUrl, {
      method: "POST",
      headers: {
        Authorization: CONFIG.apiKey,
        "X-AAI-Model": CONFIG.model,
      },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? "inference_timeout" : "upstream_unreachable",
      message: timedOut
        ? "AssemblyAI did not respond within 45 s."
        : `Could not reach AssemblyAI: ${String(err?.message || err)}`,
    });
  }
  const roundTripMs = Math.round(performance.now() - startedAt);

  const raw = await upstream.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { error: "bad_upstream_response", message: raw.slice(0, 500) };
  }

  if (!upstream.ok) {
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    console.warn(`[speakdown] upstream ${upstream.status}:`, payload?.error || raw.slice(0, 200));
    return sendJson(res, upstream.status, {
      error: payload?.error || `upstream_${upstream.status}`,
      message: payload?.message || payload?.error || `AssemblyAI returned ${upstream.status}.`,
      _speakdown: { roundTripMs, status: upstream.status },
    });
  }

  payload._speakdown = {
    roundTripMs,
    networkMs: Math.max(0, roundTripMs - (payload.request_time_ms || 0)),
    sentBytes: audio.length,
    language: config.language_code,
    keytermCount: Array.isArray(config.keyterms_prompt) ? config.keyterms_prompt.length : 0,
    contextTurns: Array.isArray(config.conversation_context) ? config.conversation_context.length : 0,
  };

  return sendJson(res, 200, payload);
}

/**
 * Assemble the upstream `config` object from query parameters.
 *
 * The three accuracy levers, and why Speakdown uses each:
 *   keyterms_prompt      — the voice-command vocabulary, so "heading two" comes
 *                          back as those words and not "heading too".
 *   prompt               — tells the model this is markdown dictation with
 *                          spoken formatting commands.
 *   conversation_context — the preceding utterances, so the model keeps proper
 *                          nouns and terminology consistent across a document.
 */
function buildUpstreamConfig(url, wav) {
  const q = url.searchParams;
  const config = {};

  const language = q.get("language");
  config.language_code = LANGUAGES.some((l) => l.code === language) ? language : "en";

  // Per-word timings power the confidence heatmap in the editor.
  config.timestamps = q.get("timestamps") !== "0";

  if (wav?.sampleRate) config.sample_rate = wav.sampleRate;
  if (wav?.channels) config.channels = wav.channels;

  const keyterms = parseJsonParam(q.get("keyterms"));
  if (Array.isArray(keyterms) && keyterms.length) {
    config.keyterms_prompt = clampKeyterms(keyterms);
  }

  const context = parseJsonParam(q.get("context"));
  if (Array.isArray(context) && context.length) {
    // Docs: chronological, oldest first. Cap at 100 turns.
    config.conversation_context = context.slice(-100).map(String);
  }

  const prompt = q.get("prompt");
  if (prompt) config.prompt = prompt.slice(0, 4096);

  return config;
}

/** keyterms_prompt is capped at 2048 characters across all terms. Trim to fit. */
function clampKeyterms(terms, maxChars = 2048) {
  const out = [];
  let used = 0;
  for (const term of terms) {
    const t = String(term).trim();
    if (!t) continue;
    if (used + t.length + 1 > maxChars) break;
    out.push(t);
    used += t.length + 1;
  }
  return out;
}

function parseJsonParam(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WAV header inspection
// ---------------------------------------------------------------------------

/**
 * Minimal RIFF/WAVE header read. Returns null if it does not look like a WAV,
 * in which case we let the API be the judge.
 */
export function describeWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let fmt = null;
  let dataBytes = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      // Some encoders write 0 or 0xFFFFFFFF for streamed data; fall back to what is present.
      const remaining = buf.length - body;
      dataBytes = size > 0 && size <= remaining ? size : remaining;
      if (fmt) break;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt || dataBytes == null || !fmt.sampleRate || !fmt.channels || !fmt.bitsPerSample) {
    return null;
  }

  const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
  const durationMs = bytesPerFrame > 0 ? (dataBytes / bytesPerFrame / fmt.sampleRate) * 1000 : 0;

  return { ...fmt, dataBytes, durationMs };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";

  const target = path.join(PUBLIC_DIR, path.normalize(rel));
  // Containment check — no path traversal out of public/.
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return sendText(res, 403, "Forbidden");
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return sendText(res, 404, "Not found");
  }
  if (stat.isDirectory()) return sendText(res, 404, "Not found");

  const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    // Local dev tool: never cache, so a reload always shows your edits.
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error("Payload too large");
        err.code = "TOO_LARGE";
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Tiny .env reader so `node server/index.js` works with no flags and no deps. */
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export { CONFIG, LANGUAGES, LIMITS, clampKeyterms, buildUpstreamConfig, server, start };
