import test from "node:test";
import assert from "node:assert/strict";

import {
  concatFrames,
  resample,
  floatToInt16,
  encodeWav,
  floatToPcmBytes,
  StreamingResampler,
  rms,
  TARGET_SAMPLE_RATE,
} from "../public/js/wav.js";

/** Read back a canonical 44-byte RIFF header, so encodeWav can be verified. */
function readWavHeader(buffer) {
  const view = new DataView(buffer);
  const ascii = (o, n) =>
    String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    durationMs: (dataBytes / ((bitsPerSample / 8) * channels) / sampleRate) * 1000,
  };
}

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

  const described = readWavHeader(buffer);
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

test("floatToPcmBytes produces little-endian 16-bit bytes", () => {
  const bytes = floatToPcmBytes(new Float32Array([0, 1, -1]));
  assert.equal(bytes.length, 6);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 32767);
  assert.equal(view.getInt16(4, true), -32768);
});

test("StreamingResampler passes through when the rate already matches", () => {
  const r = new StreamingResampler(16000, 16000);
  const frame = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(r.push(frame), frame);
  assert.equal(r.flush().length, 0);
});

test("StreamingResampler carries the remainder between frames", () => {
  // 128-sample frames at 48 kHz do not divide evenly by 3. Without a carry,
  // two samples would be dropped per frame — a steady, audible drift.
  const r = new StreamingResampler(48000, 16000);
  let produced = 0;
  const frames = 30;
  for (let i = 0; i < frames; i++) produced += r.push(new Float32Array(128).fill(0.5)).length;
  produced += r.flush().length;

  const expected = (frames * 128) / 3;
  assert.ok(
    Math.abs(produced - expected) <= 1,
    `expected about ${expected} samples, produced ${produced}`,
  );
});

test("StreamingResampler matches the one-shot resampler over the same audio", () => {
  const total = new Float32Array(4800);
  for (let i = 0; i < total.length; i++) total[i] = Math.sin(i / 9);

  const oneShot = resample(total, 48000, 16000);

  const streamer = new StreamingResampler(48000, 16000);
  const parts = [];
  for (let i = 0; i < total.length; i += 128) parts.push(streamer.push(total.slice(i, i + 128)));
  parts.push(streamer.flush());
  const streamed = concatFrames(parts);

  assert.ok(Math.abs(streamed.length - oneShot.length) <= 1);
  for (let i = 0; i < Math.min(streamed.length, oneShot.length); i++) {
    assert.ok(
      Math.abs(streamed[i] - oneShot[i]) < 1e-6,
      `sample ${i}: ${streamed[i]} vs ${oneShot[i]}`,
    );
  }
});

test("rms is zero for silence and positive for signal", () => {
  assert.equal(rms(new Float32Array(128)), 0);
  assert.ok(rms(new Float32Array(128).fill(0.5)) > 0.49);
  assert.equal(rms(new Float32Array(0)), 0);
});
