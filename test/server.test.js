import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { server, CONFIG, LANGUAGES, LIMITS } from "../server/index.js";
import { sanitiseConfig, describeError } from "../server/dictation-api.js";

const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

test.after(() => server.close());

// ---------------------------------------------------------------------------
// Config endpoint and static serving
// ---------------------------------------------------------------------------

/**
 * Whether this machine has a key configured. The suite must pass either way —
 * asserting "demo" outright made it fail the moment a .env existed, which is
 * exactly the state a developer runs it in.
 */
// Invite gating has its own suite (invite.test.js); here the server is tested as
// a plain local instance regardless of what the developer's .env says.
CONFIG.inviteOnly = false;
const configured = (await (await fetch(`${base}/api/config`)).json()).mode === "live";

test("GET /api/config reports a valid mode and the 19 supported languages", async () => {
  const body = await (await fetch(`${base}/api/config`)).json();
  assert.ok(body.mode === "demo" || body.mode === "live");
  assert.equal(body.languages.length, 19);
  assert.equal(body.languages.length, LANGUAGES.length);
  assert.ok(body.languages.some((l) => l.code === "zh"));
  assert.equal(body.limits.maxAudioSeconds, 120);
});

test("the config endpoint points at the Dictation endpoint, not Sync", async () => {
  const body = await (await fetch(`${base}/api/config`)).json();
  assert.match(body.endpoint, /dictation\.assemblyai\.com/);
  assert.match(body.endpoint, /\/v1\/transcribe\/live$/);
  assert.doesNotMatch(body.endpoint, /sync\.assemblyai\.com/);
});

test("the config endpoint never leaks the API key", async () => {
  const text = await (await fetch(`${base}/api/config`)).text();
  assert.doesNotMatch(text, /apiKey/i);
  assert.doesNotMatch(text, /ASSEMBLYAI_API_KEY/);
});

test("dictation routes fail clearly with no key configured", { skip: configured ? "a key is configured on this machine" : false }, async () => {
  for (const path of ["/api/dictate/start", "/api/transcribe"]) {
    const response = await fetch(`${base}${path}`, { method: "POST", body: "x" });
    assert.equal(response.status, 503, path);
    const body = await response.json();
    assert.equal(body.error, "no_api_key");
    assert.match(body.message, /\.env/);
  }
});

test("a malformed start config is rejected before anything is sent upstream", { skip: configured ? false : "needs a configured key" }, async () => {
  const response = await fetch(`${base}/api/dictate/start`, { method: "POST", body: "not json" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "bad_request");
});

test("an unknown chunk session 404s rather than crashing", async () => {
  const response = await fetch(`${base}/api/dictate/chunk?session=nope`, {
    method: "POST",
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "no_session");
});

test("an unknown API route 404s as JSON", async () => {
  const response = await fetch(`${base}/api/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "not_found");
});

test("the editor and its modules are served", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<title>Speakdown/);

  for (const path of ["/js/app.js", "/js/wav.js", "/js/dictation.js", "/js/capture-worklet.js"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /javascript/, path);
  }
});

test("path traversal out of public/ is refused", async () => {
  for (const attempt of ["/%2e%2e/.env", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/js/%2e%2e/%2e%2e/server/index.js"]) {
    const response = await fetch(`${base}${attempt}`);
    assert.ok(response.status === 403 || response.status === 404, `${attempt} -> ${response.status}`);
    assert.doesNotMatch(await response.text(), /ASSEMBLYAI_API_KEY/);
  }
});

// ---------------------------------------------------------------------------
// Config sanitising — what actually goes on the wire
// ---------------------------------------------------------------------------

test("sanitiseConfig drops unknown fields so a client cannot smuggle them", () => {
  const config = sanitiseConfig({ language_codes: ["en"], evil: "x", model: "gpt" });
  assert.deepEqual(Object.keys(config), ["language_codes"]);
});

test("sanitiseConfig normalises language_codes to a valid array", () => {
  assert.deepEqual(sanitiseConfig({ language_codes: "de" }).language_codes, ["de"]);
  assert.deepEqual(sanitiseConfig({ language_codes: ["zz"] }).language_codes, ["en"]);
  assert.deepEqual(sanitiseConfig({ language_codes: ["ja", "zz"] }).language_codes, ["ja"]);
});

test("sanitiseConfig clamps keyterms_prompt to the documented 2048 characters", () => {
  const config = sanitiseConfig({ keyterms_prompt: ["alpha", "beta", "x".repeat(4000), "gamma"] });
  assert.deepEqual(config.keyterms_prompt, ["alpha", "beta"]);

  const total = config.keyterms_prompt.reduce((a, t) => a + t.length + 1, 0);
  assert.ok(total <= LIMITS.maxKeytermsChars);
});

test("sanitiseConfig truncates stt_prompt to 4096 characters", () => {
  const config = sanitiseConfig({ stt_prompt: "y".repeat(9000) });
  assert.equal(config.stt_prompt.length, 4096);
});

test("an empty llm_instruction is omitted, keeping the default cleanup", () => {
  // The docs are explicit: omitting the field runs the default disfluency
  // removal. Sending "" would be a config field that fails validation.
  assert.equal("llm_instruction" in sanitiseConfig({ llm_instruction: "" }), false);
  assert.equal("llm_instruction" in sanitiseConfig({ llm_instruction: "   " }), false);
  assert.equal("llm_instruction" in sanitiseConfig({ llm_instruction: null }), false);
  assert.equal(sanitiseConfig({ llm_instruction: " Tidy it up. " }).llm_instruction, "Tidy it up.");
});

// ---------------------------------------------------------------------------
// Error mapping — this endpoint's status codes are not the usual ones
// ---------------------------------------------------------------------------

test("404 is treated as an auth failure, not a missing route", () => {
  // The Dictation API returns 404 for an invalid key. Treating it as "not
  // found" would send the user hunting for a wrong URL instead of a wrong key.
  const described = describeError(404, { detail: "Invalid API key" });
  assert.equal(described.error, "invalid_api_key");
  assert.equal(described.fatal, true);
  assert.match(described.message, /404/);
});

test("the documented failure statuses each map to something actionable", () => {
  assert.equal(describeError(401, {}).error, "no_credential");
  assert.equal(describeError(413, {}).error, "audio_too_large");
  assert.equal(describeError(415, {}).error, "unsupported_media_type");
  assert.equal(describeError(429, {}).error, "rate_limited");
  assert.equal(describeError(503, {}).error, "capacity_exceeded");
  assert.equal(describeError(502, {}).error, "upstream_unavailable");
  assert.equal(describeError(504, {}).error, "upstream_unavailable");
  assert.equal(describeError(400, { error_code: "bad_config" }).error, "bad_config");
});

test("only auth failures are marked fatal", () => {
  assert.equal(describeError(429, {}).fatal, undefined);
  assert.equal(describeError(503, {}).fatal, undefined);
  assert.ok(describeError(404, {}).fatal);
  assert.ok(describeError(401, {}).fatal);
});

// ---------------------------------------------------------------------------
// The wire format, against a stand-in upstream
// ---------------------------------------------------------------------------

/**
 * Run the real client against a local server that records exactly what it
 * received. This is the check that the multipart body matches what the
 * Dictation API documents — config part first, audio second, right headers.
 */
async function withFakeUpstream(run) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    const arrivals = [];
    const openedAt = Date.now();
    req.on("data", (c) => {
      chunks.push(c);
      arrivals.push({ atMs: Date.now() - openedAt, bytes: c.length });
    });
    req.on("end", () => {
      received.push({
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("binary"),
        arrivals,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: "um hello there",
          llm_response: "hello there",
          llm_error: null,
          words: [{ text: "hello", confidence: 0.99 }],
          confidence: 0.97,
          audio_duration_ms: 900,
          session_id: "fake",
          request_time_ms: 320,
          sync_time_ms: 110,
        }),
      );
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${upstream.address().port}/v1/transcribe/live`;
  try {
    return await run({ url, received });
  } finally {
    upstream.close();
  }
}

test("the buffered request puts config before audio, with the documented headers", async () => {
  const { transcribeBuffered } = await import("../server/dictation-api.js");

  await withFakeUpstream(async ({ url, received }) => {
    const payload = await transcribeBuffered({
      apiKey: "test-key-123",
      url,
      config: { language_codes: ["en"], keyterms_prompt: ["bullet list"] },
      audio: Buffer.from("RIFFfake-wav-bytes"),
      contentType: "audio/wav",
    });

    assert.equal(payload.text, "um hello there");
    assert.equal(payload.llm_response, "hello there");
    // request_time_ms minus sync_time_ms is what the rewrite cost.
    assert.equal(payload._speakdown.rewriteMs, 210);

    const [request] = received;
    assert.equal(request.authorization, "test-key-123", "raw key, no Bearer prefix");
    assert.match(request.contentType, /^multipart\/form-data; boundary=/);

    const configAt = request.body.indexOf('name="config"');
    const audioAt = request.body.indexOf('name="audio"');
    assert.ok(configAt > -1 && audioAt > -1, "both parts must be present");
    assert.ok(configAt < audioAt, "config must come before audio or the API 400s");

    assert.match(request.body, /Content-Type: application\/json/);
    assert.match(request.body, /Content-Type: audio\/wav/);
    assert.match(request.body, /"keyterms_prompt":\["bullet list"\]/);
    assert.match(request.body, /RIFFfake-wav-bytes/);
  });
});

test("the streaming request sends config immediately and audio as it is written", async () => {
  const { openStream } = await import("../server/dictation-api.js");

  await withFakeUpstream(async ({ url, received }) => {
    const stream = openStream({
      apiKey: "test-key-123",
      url,
      config: { sample_rate: 16000, channels: 1 },
      contentType: "audio/pcm",
    });

    // Frames written over time, as a microphone would produce them.
    for (let i = 0; i < 4; i++) {
      stream.write(Buffer.alloc(1920, i)); // 60 ms of 16 kHz mono 16-bit
      await new Promise((r) => setTimeout(r, 60));
    }
    const payload = await stream.end();

    assert.equal(payload.llm_response, "hello there");
    assert.equal(stream.bytes, 4 * 1920);

    const [request] = received;
    const configAt = request.body.indexOf('name="config"');
    const audioAt = request.body.indexOf('name="audio"');
    assert.ok(configAt < audioAt, "config must still lead on the streaming path");
    assert.match(request.body, /Content-Type: audio\/pcm/);
    assert.match(request.body, /"sample_rate":16000/);

    // The body must actually have arrived in pieces over time, not in one go —
    // that is the difference between streaming and buffering.
    assert.ok(request.arrivals.length > 1, `expected several arrivals, got ${request.arrivals.length}`);
    const span = request.arrivals[request.arrivals.length - 1].atMs - request.arrivals[0].atMs;
    assert.ok(span >= 100, `body should arrive spread over time, spanned ${span}ms`);
  });
});

test("the streaming write refuses audio beyond the 120 s cap", async () => {
  const { openStream } = await import("../server/dictation-api.js");

  await withFakeUpstream(async ({ url }) => {
    const stream = openStream({ apiKey: "k", url, config: {} });
    assert.equal(stream.write(Buffer.alloc(1000)), true);
    assert.equal(stream.write(Buffer.alloc(LIMITS.maxAudioBytes)), false, "must refuse an overlong write");
    await stream.end();
  });
});

test("an upstream 404 surfaces as a fatal invalid-key error", async () => {
  const { transcribeBuffered } = await import("../server/dictation-api.js");

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 404, title: "Not Found", detail: "Invalid API key" }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    await assert.rejects(
      () =>
        transcribeBuffered({
          apiKey: "wrong",
          url: `http://127.0.0.1:${upstream.address().port}/`,
          config: {},
          audio: Buffer.from("RIFF"),
        }),
      (err) => {
        assert.equal(err.code, "invalid_api_key");
        assert.equal(err.fatal, true);
        assert.equal(err.status, 404);
        return true;
      },
    );
  } finally {
    upstream.close();
  }
});
