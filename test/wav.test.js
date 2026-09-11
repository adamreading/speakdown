import test from "node:test";
import assert from "node:assert/strict";

import {
  concatFrames,
  resample,
  floatToInt16,
  encodeWav,
  rms,
  TARGET_SAMPLE_RATE,
} from "../public/js/wav.js";
import { describeWav } from "../server/index.js";

test("concatFrames joins frames in order", () => {
  const out = concatFrames([
    new Float32Array([1, 2]),
    new Float32Array([3]),
    new Float32Array([4, 5]),
  ]);
  assert.equal(out.length, 5);
  assert.deepEqual([...out], [1, 2, 3, 4, 5]);
});

test("resample is a no-op at the same rate", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(resample(input, 16000, 16000), input);
});

test("resample block-averages an integer ratio (48k -> 16k)", () => {
  const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1]);
  const out = resample(input, 48000, 16000);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0] - 0.3) < 1e-6, `expected ~0.3, got ${out[0]}`);
  assert.ok(Math.abs(out[1] - 1) < 1e-6, `expected ~1, got ${out[1]}`);
});

test("resample handles a fractional ratio without blowing up", () => {
  const input = new Float32Array(441).fill(0.5);
  const out = resample(input, 44100, 16000);
  assert.equal(out.length, 160);
  for (const sample of out) assert.ok(Math.abs(sample - 0.5) < 0.01);
});

test("floatToInt16 clamps out-of-range samples", () => {
  const out = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(out[0], 0);
  assert.equal(out[1], 32767);
  assert.equal(out[2], -32768);
  assert.equal(out[3], 32767, "values above 1 must clamp, not wrap");
  assert.equal(out[4], -32768, "values below -1 must clamp, not wrap");
  assert.ok(out[5] > 16000 && out[5] < 16500);
});

test("encodeWav writes a header the server can parse back", () => {
  const samples = floatToInt16(new Float32Array(16000).fill(0.25)); // exactly 1 s
  const buffer = encodeWav(samples, TARGET_SAMPLE_RATE);

  assert.equal(buffer.byteLength, 44 + 16000 * 2);

  const described = describeWav(Buffer.from(buffer));
  assert.ok(described, "header should be parseable");
  assert.equal(described.sampleRate, 16000);
  assert.equal(described.channels, 1);
  assert.equal(described.bitsPerSample, 16);
  assert.ok(Math.abs(described.durationMs - 1000) < 1, `got ${described.durationMs}ms`);
});

test("encodeWav round-trips sample values little-endian", () => {
  const buffer = encodeWav(new Int16Array([0, 1000, -1000, 32767]), 16000);
  const view = new DataView(buffer);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 1000);
  assert.equal(view.getInt16(48, true), -1000);
  assert.equal(view.getInt16(50, true), 32767);
});

test("describeWav rejects non-WAV input", () => {
  assert.equal(describeWav(Buffer.from("not audio at all, not even close")), null);
  assert.equal(describeWav(Buffer.alloc(10)), null);
});

test("rms is zero for silence and positive for signal", () => {
  assert.equal(rms(new Float32Array(128)), 0);
  assert.ok(rms(new Float32Array(128).fill(0.5)) > 0.49);
  assert.equal(rms(new Float32Array(0)), 0);
});
