import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_SCRIPT } from "../public/js/dictation.js";

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/demo");
const manifest = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, "manifest.json"), "utf8"));

test("every demo line has a voiced clip, in order, with the text it was rendered from", () => {
  assert.equal(manifest.length, DEMO_SCRIPT.length);
  manifest.forEach((clip, i) => {
    assert.equal(clip.index, i);
    assert.equal(clip.text, DEMO_SCRIPT[i].text, `line ${i} was rendered from stale text — rerun scripts/make-demo-audio.mjs`);
  });
});

test("every clip exists, is an MP3, and has a plausible duration", () => {
  for (const clip of manifest) {
    const file = path.join(DEMO_DIR, clip.file);
    assert.ok(fs.existsSync(file), `${clip.file} missing`);
    const head = fs.readFileSync(file).subarray(0, 3);
    const isMp3 = head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    assert.ok(isMp3, `${clip.file} is not an MP3`);
    assert.ok(clip.durationMs > 400 && clip.durationMs < 20_000, `${clip.file}: ${clip.durationMs} ms`);
  }
});

test("clips stay small enough to ship in the repo", () => {
  const total = manifest.reduce((sum, clip) => sum + fs.statSync(path.join(DEMO_DIR, clip.file)).size, 0);
  assert.ok(total < 3 * 1024 * 1024, `${(total / 1024).toFixed(0)} KB of demo audio`);
});
