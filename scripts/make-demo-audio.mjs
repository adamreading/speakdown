#!/usr/bin/env node
/**
 * Voice the scripted demo.
 *
 * Renders every line of DEMO_SCRIPT through an OpenAI-compatible TTS endpoint
 * (Chatterbox locally, by default), trims the silence the model leaves at
 * either end, encodes to a small mono MP3 and writes public/demo/manifest.json
 * with the exact duration of each clip. The demo plays these and treats the
 * moment a clip ends as the moment the speaker stopped, so the transcript
 * timing is driven by the audio rather than guessed from text length.
 *
 *   node scripts/make-demo-audio.mjs                # all lines
 *   node scripts/make-demo-audio.mjs --only 3,12    # re-render a few
 *
 * Env: TTS_URL (default http://127.0.0.1:8882/v1/audio/speech),
 *      TTS_VOICE (default en-Finn_man), TTS_MODEL (default tts-1).
 * Needs ffmpeg + ffprobe on PATH. Nothing here runs in the browser.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEMO_SCRIPT } from "../public/js/dictation.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "demo");
const TTS_URL = process.env.TTS_URL || "http://127.0.0.1:8882/v1/audio/speech";
const VOICE = process.env.TTS_VOICE || "en-Finn_man";
const MODEL = process.env.TTS_MODEL || "tts-1";

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : new Set(process.argv[i + 1].split(",").map(Number));
})();

await fs.mkdir(OUT, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "speakdown-tts-"));
let manifest = [];
try {
  manifest = JSON.parse(await fs.readFile(path.join(OUT, "manifest.json"), "utf8"));
} catch {}

for (let i = 0; i < DEMO_SCRIPT.length; i++) {
  const entry = DEMO_SCRIPT[i];
  const file = `${String(i).padStart(2, "0")}.mp3`;
  if (only && !only.has(i)) continue;

  const started = Date.now();
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input: entry.text, response_format: "wav" }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status} on line ${i}: ${await res.text()}`);
  const raw = path.join(tmp, `${i}.wav`);
  await fs.writeFile(raw, Buffer.from(await res.arrayBuffer()));

  // Trim silence at both ends (keep 120 ms of air), then encode.
  const out = path.join(OUT, file);
  run("ffmpeg", [
    "-y", "-v", "error", "-i", raw,
    "-af",
    "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.12," +
      "areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.12,areverse",
    "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", out,
  ]);
  const durationMs = Math.round(
    Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out])) * 1000,
  );

  manifest[i] = { index: i, file, text: entry.text, durationMs, voice: VOICE };
  console.log(`${file}  ${String(durationMs).padStart(5)} ms  (${Date.now() - started} ms to render)  ${entry.text.slice(0, 60)}`);
}

manifest = manifest.filter(Boolean).sort((a, b) => a.index - b.index);
await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n${manifest.length}/${DEMO_SCRIPT.length} clips in ${path.relative(ROOT, OUT)}/`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
