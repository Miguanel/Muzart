// Port AudioAnalyzer.kt — RMS + 5 pasm FFT dla wizualizacji fali na zegarach.

const FFT_SIZE = 1024;
const _re = new Float64Array(FFT_SIZE);
const _im = new Float64Array(FFT_SIZE);
const _mag = new Float64Array(FFT_SIZE / 2);

function fftMagnitudes(input) {
  const n = FFT_SIZE;
  _re.fill(0); _im.fill(0);
  const len = Math.min(input.length, n);
  for (let i = 0; i < len; i++) _re[i] = input[i];
  // Odwrócenie bitów
  for (let i = 0, j = 0; i < n - 1; i++) {
    if (i < j) {
      let t = _re[i]; _re[i] = _re[j]; _re[j] = t;
      t = _im[i]; _im[i] = _im[j]; _im[j] = t;
    }
    let m = n >> 1;
    while (j >= m && m > 0) { j -= m; m >>= 1; }
    j += m;
  }
  for (let step = 1; step < n; step <<= 1) {
    const jump = step << 1;
    const angle = -Math.PI / step;
    const mR = Math.cos(angle), mI = Math.sin(angle);
    let dR = 1, dI = 0;
    for (let b = 0; b < step; b++) {
      for (let i = b; i < n; i += jump) {
        const j2 = i + step;
        const tr = dR * _re[j2] - dI * _im[j2];
        const ti = dR * _im[j2] + dI * _re[j2];
        _re[j2] = _re[i] - tr; _im[j2] = _im[i] - ti;
        _re[i] += tr; _im[i] += ti;
      }
      const t = dR * mR - dI * mI;
      dI = dR * mI + dI * mR;
      dR = t;
    }
  }
  for (let i = 0; i < n / 2; i++) _mag[i] = Math.sqrt(_re[i] * _re[i] + _im[i] * _im[i]);
  return _mag;
}

function bandAvg(mag, s, e) {
  const end = Math.min(e, mag.length - 1);
  let sum = 0;
  for (let i = s; i <= end; i++) sum += mag[i];
  return end >= s ? sum / (end - s + 1) : 0;
}

const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** @param {Float32Array} audio próbki w zakresie -1..1 */
export function processAudioChunk(audio) {
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i];
  const amplitude = audio.length ? Math.sqrt(sumSq / audio.length) * 20 : 0;
  const mag = fftMagnitudes(audio);
  return {
    amplitude: c01(amplitude),
    subBass: c01(bandAvg(mag, 0, 1) * 3),
    bass: c01(bandAvg(mag, 2, 5) * 2),
    mid: c01(bandAvg(mag, 6, 46) * 1.2),
    highMid: c01(bandAvg(mag, 47, 139) * 1.4),
    treble: c01(bandAvg(mag, 140, 511) * 1.6),
  };
}

export const emptyPoint = () => ({ amplitude: 0, subBass: 0, bass: 0, mid: 0, highMid: 0, treble: 0 });

/** Fala „zegarowa” — 180 punktów z analizą pasm (Studio). */
export function generateClockWaveform(pcm, resolution = 180) {
  const out = [];
  const chunk = pcm.length > resolution ? Math.floor(pcm.length / resolution) : 1;
  for (let i = 0; i < resolution; i++) {
    const start = Math.min(i * chunk, pcm.length);
    const end = Math.min((i + 1) * chunk, pcm.length);
    if (start < end) {
      const n = end - start;
      const f = new Float32Array(n);
      for (let k = 0; k < n; k++) f[k] = pcm[start + k] / 32767;
      out.push(processAudioChunk(f));
    } else out.push(emptyPoint());
  }
  return out;
}

/** Prosta fala szczytowa — 100 wartości 0..1 (Aranżer Chronos). */
export function generateSimpleWaveform(pcm, resolution = 100) {
  if (!pcm || pcm.length === 0) return [];
  const step = Math.max(1, Math.floor(pcm.length / resolution));
  const out = new Array(resolution);
  for (let i = 0; i < resolution; i++) {
    let max = 0;
    const start = i * step;
    const end = Math.min(start + step, pcm.length);
    for (let j = start; j < end; j++) {
      const a = Math.abs(pcm[j]) / 32767;
      if (a > max) max = a;
    }
    out[i] = max;
  }
  return out;
}
