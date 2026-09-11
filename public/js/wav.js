/**
 * Float32 audio -> 16-bit PCM WAV, in the browser.
 *
 * This module exists because of one hard constraint in the AssemblyAI Sync API:
 * it accepts "WAV or raw PCM S16LE — 16-bit only". The browser's MediaRecorder
 * hands you webm/opus, which the endpoint will not take. So we capture raw
 * Float32 frames via Web Audio and encode the container ourselves.
 *
 * It is the single most common place a dictation integration goes wrong, so it
 * is isolated here and unit-tested in test/wav.test.js.
 */

export const TARGET_SAMPLE_RATE = 16000;

/**
 * Concatenate Float32 frames into one contiguous buffer.
 * @param {Float32Array[]} frames
 * @returns {Float32Array}
 */
export function concatFrames(frames) {
  let length = 0;
  for (const f of frames) length += f.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/**
 * Resample Float32 audio to a target rate.
 *
 * Downsampling without a low-pass filter aliases high frequencies down into the
 * speech band and measurably hurts transcription accuracy. So:
 *   - integer ratios (48k->16k is the common one) use block averaging, which is
 *     a cheap box-filter decimation and removes most of the aliasing
 *   - non-integer ratios use linear interpolation over a 2-tap pre-smoothed
 *     signal, which is not perfect but is well behaved for speech
 *
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resample(samples, fromRate, toRate) {
  if (!samples.length || fromRate === toRate) return samples;

  const ratio = fromRate / toRate;

  if (Number.isInteger(ratio) && ratio > 1) {
    const outLength = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      let sum = 0;
      const base = i * ratio;
      for (let j = 0; j < ratio; j++) sum += samples[base + j];
      out[i] = sum / ratio;
    }
    return out;
  }

  // Mild pre-smoothing when downsampling by a fractional ratio.
  let src = samples;
  if (ratio > 1) {
    src = new Float32Array(samples.length);
    src[0] = samples[0];
    for (let i = 1; i < samples.length; i++) {
      src[i] = (samples[i] + samples[i - 1]) * 0.5;
    }
  }

  const outLength = Math.floor(src.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = src[idx];
    const b = idx + 1 < src.length ? src[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Clamp and convert Float32 [-1, 1] to Int16 little-endian.
 * @param {Float32Array} samples
 * @returns {Int16Array}
 */
export function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    // Asymmetric scaling: Int16 range is -32768..32767.
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Wrap Int16 mono samples in a 44-byte canonical RIFF/WAVE header.
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = samples.length * 2;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }

  return buffer;
}

/**
 * Full pipeline: raw captured frames at the device rate -> WAV blob at 16 kHz.
 * @param {Float32Array[]} frames
 * @param {number} sourceRate
 * @returns {{blob: Blob, durationMs: number, sampleRate: number, sampleCount: number}}
 */
export function framesToWav(frames, sourceRate) {
  const joined = concatFrames(frames);
  const resampled = resample(joined, sourceRate, TARGET_SAMPLE_RATE);
  const pcm = floatToInt16(resampled);
  const buffer = encodeWav(pcm, TARGET_SAMPLE_RATE);
  return {
    blob: new Blob([buffer], { type: "audio/wav" }),
    durationMs: (resampled.length / TARGET_SAMPLE_RATE) * 1000,
    sampleRate: TARGET_SAMPLE_RATE,
    sampleCount: resampled.length,
  };
}

/**
 * Root-mean-square level of a frame, used for the meter and for voice activity
 * detection.
 * @param {Float32Array} frame
 * @returns {number} 0..1
 */
export function rms(frame) {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
