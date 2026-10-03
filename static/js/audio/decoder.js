// Port AudioImportUtils.kt — dekodowanie MP3/WAV/M4A/OGG… do PCM 16-bit mono 44.1 kHz.
import { engine } from "./engine.js";
import { SAMPLE_RATE } from "./dsp.js";

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

export async function resampleFloat(f32, fromRate, toRate) {
  if (fromRate === toRate || f32.length === 0) return f32;
  const length = Math.max(1, Math.round((f32.length * toRate) / fromRate));
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Offline) {
    try {
      const off = new Offline(1, length, toRate);
      const buf = off.createBuffer(1, f32.length, fromRate);
      buf.getChannelData(0).set(f32);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      return rendered.getChannelData(0).slice();
    } catch (e) {
      console.warn("OfflineAudioContext resample failed, using linear", e);
    }
  }
  const out = new Float32Array(length);
  const ratio = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, f32.length - 1);
    const fr = x - i0;
    out[i] = f32[i0] * (1 - fr) + f32[i1] * fr;
  }
  return out;
}

/** @returns {Promise<{pcm: Int16Array, durationMs: number}>} */
export async function decodeAudioFile(file) {
  const ctx = engine.init();
  const data = await file.arrayBuffer();
  const audioBuffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
  // Stereo -> mono (uśrednienie kanałów)
  const n = audioBuffer.length;
  const mono = new Float32Array(n);
  const chs = audioBuffer.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
  }
  const resampled = await resampleFloat(mono, audioBuffer.sampleRate, SAMPLE_RATE);
  const pcm = floatToInt16(resampled);
  return { pcm, durationMs: Math.round(audioBuffer.duration * 1000) };
}
