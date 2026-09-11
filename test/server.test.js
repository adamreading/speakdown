import test from "node:test";
import assert from "node:assert/strict";

import { server, clampKeyterms, LANGUAGES, LIMITS } from "../server/index.js";

/** Start the real server on an ephemeral port for the duration of the suite. */
const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve(`http://127.0.0.1:${port}`);
  });
});

test.after(() => server.close());

test("GET /api/config reports the mode and the language list", async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);

  const body = await response.json();
  // The test environment has no key, so this must be demo mode.
  assert.equal(body.mode, "demo");
  assert.equal(body.languages.length, LANGUAGES.length);
  assert.ok(body.languages.some((l) => l.code === "en"));
  assert.equal(body.limits.maxDurationMs, LIMITS.maxDurationMs);
});

test("the config endpoint never leaks the API key", async () => {
  const text = await (await fetch(`${base}/api/config`)).text();
  assert.doesNotMatch(text, /apiKey/i);
  assert.doesNotMatch(text, /ASSEMBLYAI_API_KEY/);
});

test("POST /api/transcribe without a key fails clearly rather than silently", async () => {
  const response = await fetch(`${base}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.error, "no_api_key");
  assert.match(body.message, /\.env/);
});

test("an unknown API route 404s as JSON", async () => {
  const response = await fetch(`${base}/api/nope`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, "not_found");
});

test("the editor is served at the root", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);

  const html = await response.text();
  assert.match(html, /<title>Speakdown/);
  assert.match(html, /\/js\/app\.js/);
});

test("client modules are served with a JavaScript content type", async () => {
  for (const path of [
    "/js/app.js",
    "/js/wav.js",
    "/js/commands.js",
    "/js/pipeline.js",
    "/js/capture-worklet.js",
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path} should be served`);
    assert.match(response.headers.get("content-type"), /javascript/, path);
  }
});

test("path traversal out of public/ is refused", async () => {
  // Encoded so the fetch client cannot normalise the ../ away before sending.
  for (const attempt of [
    "/%2e%2e/.env",
    "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/js/%2e%2e/%2e%2e/server/index.js",
  ]) {
    const response = await fetch(`${base}${attempt}`);
    assert.ok(
      response.status === 403 || response.status === 404,
      `${attempt} returned ${response.status}`,
    );
    const body = await response.text();
    assert.doesNotMatch(body, /ASSEMBLYAI_API_KEY/);
  }
});

test("a missing static file 404s", async () => {
  const response = await fetch(`${base}/js/does-not-exist.js`);
  assert.equal(response.status, 404);
});

test("clampKeyterms trims to the documented 2048-character budget", () => {
  const terms = clampKeyterms(["alpha", "beta", "x".repeat(4000), "gamma"]);
  assert.deepEqual(terms, ["alpha", "beta"]);

  const total = terms.reduce((acc, t) => acc + t.length + 1, 0);
  assert.ok(total <= 2048);
});

test("clampKeyterms drops blanks and trims whitespace", () => {
  assert.deepEqual(clampKeyterms(["  spaced  ", "", "   ", "ok"]), ["spaced", "ok"]);
});
