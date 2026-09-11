/**
 * Speakdown — local server.
 *
 * Three jobs:
 *   1. Serve the static editor from ../public
 *   2. Hold the API key, so it never reaches the browser
 *   3. Bridge the browser to the Dictation API's streaming upload
 *
 * On that third point. The Dictation endpoint transcribes audio as it arrives,
 * so uploading during the recording means the speaker only waits for the tail
 * once they stop. Doing that from the browser directly is not possible: Chrome
 * only allows a streamed fetch body over HTTP/2, a local dev server is HTTP/1.1,
 * and the attempt fails with ERR_ALPN_NEGOTIATION_FAILED. (Firefox and Safari do
 * not support request streaming at all.)
 *
 * So the browser posts each ~120 ms of PCM as its own small request to
 * /api/dictate/chunk, and this process feeds those frames into a single
 * long-lived upstream request it opened at /api/dictate/start. The hop to
 * localhost costs microseconds; the hop that matters — this machine to
 * AssemblyAI — is a genuine chunked upload that begins while the user is still
 * speaking.
 *
 * Zero npm dependencies: node:http, native fetch and ReadableStream only.
 * Requires Node 20+.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  LANGUAGES,
  LIMITS,
  sanitiseConfig,
  transcribeBuffered,
  openStream,
} from "./dictation-api.js";
import { InviteStore, tokenFromRequest, inviteCookie, clearInviteCookie } from "./invite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

loadEnvFile(path.join(ROOT, ".env"));

const CONFIG = {
  apiKey: (process.env.ASSEMBLYAI_API_KEY || "").trim(),
  apiUrl: (
    process.env.SPEAKDOWN_API_URL || "https://dictation.assemblyai.com/v1/transcribe/live"
  ).trim(),
  port: Number(process.env.PORT || 3000),
  /**
   * Hosted-instance protection. When set, live dictation is unlocked only for
   * browsers that arrived through `node server/invite.js create`; everyone
   * else gets Demo Mode. Off by default so a local clone behaves as the README
   * says. See server/invite.js.
   */
  inviteOnly: isTruthy(process.env.SPEAKDOWN_INVITE_ONLY),
  inviteStore: new InviteStore(),
  /** Upper bound on simultaneous upstream requests — a cap on how fast credit can drain. */
  maxLiveSessions: Number(process.env.SPEAKDOWN_MAX_LIVE_SESSIONS || 6),
};

/** Live streaming sessions, keyed by id. Reaped if a client vanishes. */
const sessions = new Map();
const SESSION_TTL_MS = 150_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".wav": "audio/wav",
};

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/config": {
        const access = resolveAccess(req, url);
        return sendJson(res, 200, {
          mode: access.live ? "live" : "demo",
          access: access.reason,
          inviteExpiresAt: access.invite?.expiresAt ?? null,
          endpoint: CONFIG.apiUrl,
          languages: LANGUAGES,
          limits: {
            maxAudioSeconds: LIMITS.maxAudioSeconds,
            maxKeytermsChars: LIMITS.maxKeytermsChars,
            maxLlmInstructionChars: LIMITS.maxLlmInstructionChars,
          },
        });
      }

      case "POST /api/dictate/start":
        return await handleStart(req, res, url);
      case "POST /api/dictate/chunk":
        return await handleChunk(req, res, url);
      case "POST /api/dictate/end":
        return await handleEnd(req, res, url);
      case "POST /api/dictate/abort":
        return handleAbort(req, res, url);
      case "POST /api/transcribe":
        return await handleBuffered(req, res, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "not_found", message: `No route ${req.method} ${url.pathname}` });
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error("[speakdown] unhandled:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error", message: String(err?.message || err) });
    }
  }
});

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) start();

function start() {
  server.listen(CONFIG.port, () => {
    console.log("");
    console.log("  Speakdown — dictate the prose, speak the formatting");
    console.log("  ──────────────────────────────────────────────────────");
    console.log(`  http://localhost:${CONFIG.port}`);
    console.log(`  mode:     ${CONFIG.apiKey ? "LIVE" : "DEMO (no ASSEMBLYAI_API_KEY set)"}`);
    console.log(`  endpoint: ${CONFIG.apiUrl}`);
    if (CONFIG.apiKey && CONFIG.inviteOnly) {
      const active = CONFIG.inviteStore.list().length;
      console.log(`  access:   invite-only (${active} active invite${active === 1 ? "" : "s"})`);
      console.log("            node server/invite.js create --hours 72 --label judges");
    }
    if (!CONFIG.apiKey) {
      console.log("");
      console.log("  Demo Mode replays a scripted dictation so you can see the whole");
      console.log("  editor without a key. For real dictation:");
      console.log("    cp .env.example .env   # then paste your key in");
    }
    console.log("");
  });

  setInterval(reapSessions, 30_000).unref();
}

// ---------------------------------------------------------------------------
// Streaming dictation session
// ---------------------------------------------------------------------------

/**
 * Open an upstream request now, before any audio exists.
 * The config part goes up immediately; frames follow as the user speaks.
 */
async function handleStart(req, res, url) {
  if (!CONFIG.apiKey) return noKey(res);
  const access = resolveAccess(req, url);
  if (!access.live) return inviteRequired(res, access);
  if (sessions.size >= CONFIG.maxLiveSessions) return busy(res);

  let requested = {};
  try {
    const raw = await readBody(req, 64 * 1024);
    if (raw.length) requested = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "bad_request", message: "Config must be JSON." });
  }

  // Raw PCM on the streaming path: no container header means no length to
  // backfill, so frames can leave as soon as they exist.
  const config = sanitiseConfig({
    ...requested,
    sample_rate: requested.sample_rate || 16000,
    channels: requested.channels || 1,
  });

  const id = crypto.randomUUID();
  let stream;
  try {
    stream = openStream({ apiKey: CONFIG.apiKey, url: CONFIG.apiUrl, config });
  } catch (err) {
    return sendJson(res, 502, {
      error: "upstream_unreachable",
      message: String(err?.message || err),
    });
  }

  sessions.set(id, { stream, config, openedAt: Date.now(), chunks: 0 });
  if (access.invite) CONFIG.inviteStore.touch(access.invite.token);
  return sendJson(res, 200, { sessionId: id, config, startedAt: Date.now() });
}

/** One ~120 ms slab of PCM. Kept deliberately cheap — this runs constantly. */
async function handleChunk(req, res, url) {
  const session = sessions.get(url.searchParams.get("session"));
  if (!session) {
    return sendJson(res, 404, { error: "no_session", message: "Unknown or expired session." });
  }

  let chunk;
  try {
    chunk = await readBody(req, LIMITS.maxAudioBytes);
  } catch {
    return sendJson(res, 413, { error: "audio_too_large", message: "Chunk too large." });
  }

  if (chunk.length) {
    const accepted = session.stream.write(chunk);
    if (!accepted) {
      return sendJson(res, 413, {
        error: "audio_too_large",
        message: `Exceeded the ${LIMITS.maxAudioSeconds} s limit for one utterance.`,
      });
    }
    session.chunks++;
  }

  res.writeHead(204);
  res.end();
}

/** Close the body and wait for the transcript. */
async function handleEnd(req, res, url) {
  const id = url.searchParams.get("session");
  const session = sessions.get(id);
  if (!session) {
    return sendJson(res, 404, { error: "no_session", message: "Unknown or expired session." });
  }
  sessions.delete(id);

  // How long the upload had already been running when the speaker stopped.
  // This is the number that shows what streaming actually bought.
  const uploadedDuringSpeechMs = Date.now() - session.openedAt;

  try {
    const payload = await session.stream.end();
    payload._speakdown = {
      ...payload._speakdown,
      mode: "streaming",
      uploadedDuringSpeechMs,
      chunks: session.chunks,
      language: session.config.language_codes?.[0] || "en",
    };
    return sendJson(res, 200, payload);
  } catch (err) {
    return sendUpstreamError(res, err);
  }
}

function handleAbort(req, res, url) {
  const id = url.searchParams.get("session");
  const session = sessions.get(id);
  if (session) {
    session.stream.abort();
    sessions.delete(id);
  }
  res.writeHead(204);
  res.end();
}

function reapSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.openedAt > SESSION_TTL_MS) {
      session.stream.abort();
      sessions.delete(id);
      console.warn(`[speakdown] reaped stale session ${id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Buffered dictation (fallback, and the comparison mode)
// ---------------------------------------------------------------------------

/**
 * Whole clip in one request. Used where streaming is unavailable, and by the
 * A/B control in the UI that shows what uploading during speech is worth.
 */
async function handleBuffered(req, res, url) {
  if (!CONFIG.apiKey) return noKey(res);
  const access = resolveAccess(req, url);
  if (!access.live) return inviteRequired(res, access);
  if (sessions.size >= CONFIG.maxLiveSessions) return busy(res);
  if (access.invite) CONFIG.inviteStore.touch(access.invite.token);

  let audio;
  try {
    audio = await readBody(req, LIMITS.maxAudioBytes);
  } catch {
    return sendJson(res, 413, {
      error: "audio_too_large",
      message: `Audio exceeds the ${LIMITS.maxAudioSeconds} s limit.`,
    });
  }
  if (!audio.length) {
    return sendJson(res, 400, { error: "bad_request", message: "Empty audio body." });
  }

  const config = sanitiseConfig(parseJson(url.searchParams.get("config")) || {});

  try {
    const payload = await transcribeBuffered({
      apiKey: CONFIG.apiKey,
      url: CONFIG.apiUrl,
      config,
      audio,
      contentType: "audio/wav",
    });
    payload._speakdown = {
      ...payload._speakdown,
      mode: "buffered",
      language: config.language_codes?.[0] || "en",
    };
    return sendJson(res, 200, payload);
  } catch (err) {
    return sendUpstreamError(res, err);
  }
}

function sendUpstreamError(res, err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return sendJson(res, 504, {
      error: "inference_timeout",
      message: `AssemblyAI did not respond within ${LIMITS.timeoutMs / 1000} s.`,
    });
  }
  const status = err?.status || 502;
  if (err?.retryAfter) res.setHeader("Retry-After", err.retryAfter);
  console.warn(`[speakdown] upstream ${status}: ${err?.code || ""} ${err?.message || err}`);
  return sendJson(res, status, {
    error: err?.code || "upstream_error",
    message: err?.message || String(err),
    fatal: err?.fatal || false,
    _speakdown: { roundTripMs: err?.roundTripMs ?? null },
  });
}

function noKey(res) {
  return sendJson(res, 503, {
    error: "no_api_key",
    message:
      "No ASSEMBLYAI_API_KEY configured. Copy .env.example to .env and add your key, " +
      "or use Demo Mode in the UI.",
  });
}

function inviteRequired(res, access) {
  return sendJson(res, 403, {
    error: "invite_required",
    fatal: true,
    message:
      access.reason === "expired"
        ? "Your invite link has expired or was revoked. Live dictation is off; Demo Mode still works."
        : "This hosted copy of Speakdown unlocks live dictation only through an invite link.",
  });
}

function busy(res) {
  res.setHeader("Retry-After", "5");
  return sendJson(res, 429, {
    error: "busy",
    message: `Speakdown is at its limit of ${CONFIG.maxLiveSessions} simultaneous dictations. Try again in a moment.`,
  });
}

// ---------------------------------------------------------------------------
// Access — who gets live dictation
// ---------------------------------------------------------------------------

/**
 * Three outcomes: `no_key` (nothing to unlock), `open` (a local instance),
 * or on an invite-only instance `invited`, `expired` (token presented but not
 * on file) or `invite_required` (no token at all). Only `open` and `invited`
 * are live.
 */
function resolveAccess(req, url) {
  if (!CONFIG.apiKey) return { live: false, reason: "no_key", invite: null };
  if (!CONFIG.inviteOnly) return { live: true, reason: "open", invite: null };

  const { token } = tokenFromRequest(req, url);
  if (!token) return { live: false, reason: "invite_required", invite: null };
  const invite = CONFIG.inviteStore.lookup(token);
  if (!invite) return { live: false, reason: "expired", invite: null };
  return { live: true, reason: "invited", invite };
}

/**
 * Landing on `/?invite=<token>` turns the token into a cookie that lasts as
 * long as the invite. The page itself is public either way — Demo Mode is
 * the whole editor, just without a key behind it.
 */
function applyInviteCookie(req, res, url) {
  if (!CONFIG.inviteOnly) return;
  const { token, source } = tokenFromRequest(req, url);
  if (!token) return;
  const invite = CONFIG.inviteStore.lookup(token);
  if (invite) {
    if (source === "query") res.setHeader("Set-Cookie", inviteCookie(invite, req));
  } else if (source === "query") {
    // A dead link should not leave a stale cookie behind either.
    res.setHeader("Set-Cookie", clearInviteCookie());
  }
}

function isTruthy(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel === "/index.html") applyInviteCookie(req, res, url);

  const target = path.join(PUBLIC_DIR, path.normalize(rel));
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

  res.writeHead(200, {
    "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
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

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export { CONFIG, LANGUAGES, LIMITS, server, start, sessions };
