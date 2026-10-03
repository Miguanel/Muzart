// Port AudioDSP.kt — przetwarzanie PCM 16-bit mono 44.1 kHz (Int16Array).
// Moduł czysty (bez DOM), używany zarówno w wątku głównym, jak i w Web Workerze.

export const SAMPLE_RATE = 44100;

const clampShort = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0);

export function trim(pcm, startPercent, endPercent) {
  const s = Math.min(1, Math.max(0, startPercent));
  const e = Math.min(1, Math.max(0, endPercent));
  const startIdx = Math.floor(pcm.length * s);
  const endIdx = Math.max(startIdx, Math.floor(pcm.length * e));
  if (endIdx - startIdx <= 0) return new Int16Array(0);
  return pcm.slice(startIdx, endIdx);
}

export function addStartDelay(pcm, delayMs, sampleRate = SAMPLE_RATE) {
  const delaySamples = Math.floor((delayMs * sampleRate) / 1000);
  if (delaySamples <= 0) return pcm;
  const out = new Int16Array(pcm.length + delaySamples);
  out.set(pcm, delaySamples);
  return out;
}

export function changeSpeed(pcm, speedFactor) {
  if (speedFactor <= 0 || speedFactor === 1) return pcm;
  const newSize = Math.floor(pcm.length / speedFactor);
  if (newSize <= 0) return new Int16Array(0);
  const out = new Int16Array(newSize);
  const last = pcm.length - 1;
  for (let i = 0; i < newSize; i++) {
    const oldIdx = i * speedFactor;
    const idx = oldIdx | 0;
    if (idx < pcm.length) {
      const next = idx + 1 > last ? last : idx + 1;
      const frac = oldIdx - idx;
      const s1 = pcm[idx];
      out[i] = (s1 + frac * (pcm[next] - s1)) | 0;
    }
  }
  return out;
}

class Biquad {
  constructor(type, freq, sampleRate, gain, Q = 0.707) {
    const A = Math.sqrt(gain);
    const omega = (2 * Math.PI * freq) / sampleRate;
    const sn = Math.sin(omega), cs = Math.cos(omega);
    const alpha = sn / (2 * Q);
    let a0, a1, a2, b0, b1, b2;
    switch (type) {
      case "lowpass":
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case "lowshelf": {
        const sA = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cs + sA);
        b1 = 2 * A * ((A - 1) - (A + 1) * cs);
        b2 = A * ((A + 1) - (A - 1) * cs - sA);
        a0 = (A + 1) + (A - 1) * cs + sA;
        a1 = -2 * ((A - 1) + (A + 1) * cs);
        a2 = (A + 1) + (A - 1) * cs - sA;
        break;
      }
      case "highshelf": {
        const sA = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cs + sA);
        b1 = -2 * A * ((A - 1) + (A + 1) * cs);
        b2 = A * ((A + 1) + (A - 1) * cs - sA);
        a0 = (A + 1) - (A - 1) * cs + sA;
        a1 = 2 * ((A - 1) - (A + 1) * cs);
        a2 = (A + 1) - (A - 1) * cs - sA;
        break;
      }
      default: // peaking
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** 5-pasmowy EQ (60 Hz, 250 Hz, 1 kHz, 4 kHz, 12 kHz). Wzmocnienia jako mnożniki (1.0 = płasko). */
export function applyEQ(pcm, gains, sampleRate = SAMPLE_RATE) {
  if (!gains || gains.length < 5) return pcm;
  if (Array.from(gains).every((g) => g === 1)) return pcm;
  const f = [
    new Biquad("lowshelf", 60, sampleRate, gains[0]),
    new Biquad("peaking", 250, sampleRate, gains[1], 1.0),
    new Biquad("peaking", 1000, sampleRate, gains[2], 1.0),
    new Biquad("peaking", 4000, sampleRate, gains[3], 1.0),
    new Biquad("highshelf", 12000, sampleRate, gains[4]),
  ];
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i];
    s = f[0].process(s); s = f[1].process(s); s = f[2].process(s); s = f[3].process(s); s = f[4].process(s);
    out[i] = clampShort(s);
  }
  return out;
}

export function processAll(pcm, trimStart, trimEnd, delayMs, speedFactor, eqGains, sampleRate = SAMPLE_RATE) {
  let r = trim(pcm, trimStart, trimEnd);
  r = changeSpeed(r, speedFactor);
  r = applyEQ(r, eqGains, sampleRate);
  r = addStartDelay(r, delayMs, sampleRate);
  return r;
}

/** Mapowanie 0..1 na częstotliwość odcięcia filtra dolnoprzepustowego (200 Hz – 20 kHz, skala log). */
export function lowPassFrequency(cutoffFactor) {
  return 200 * Math.pow(20000 / 200, cutoffFactor);
}

export function applyLowPass(pcm, cutoffFactor, sampleRate = SAMPLE_RATE) {
  if (cutoffFactor >= 0.95) return pcm;
  const filter = new Biquad("lowpass", lowPassFrequency(cutoffFactor), sampleRate, 1.0);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clampShort(filter.process(pcm[i]));
  return out;
}

/** Twarde cięcie (cropClipPermanently). Zwraca null, gdy zakres jest zbyt krótki. */
export function crop(pcm, trimStart, trimEnd) {
  const total = pcm.length;
  const start = Math.min(total, Math.max(0, Math.floor(trimStart * total)));
  const end = Math.min(total, Math.max(start, Math.floor(trimEnd * total)));
  if (start >= end - 100) return null;
  return pcm.slice(start, end);
}

export function durationMsOf(pcm, sampleRate = SAMPLE_RATE) {
  return Math.floor((pcm.length / sampleRate) * 1000);
}
