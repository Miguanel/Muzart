// Zadania DSP wspólne dla Workera i trybu awaryjnego (wątek główny).
import { processAll, crop } from "./dsp.js";
import { generateClockWaveform, generateSimpleWaveform } from "./analyzer.js";

export function runJob(op, a) {
  switch (op) {
    case "process":
      return { pcm: processAll(a.pcm, a.trimStart, a.trimEnd, a.delayMs, a.speed, a.eq) };
    case "processClock": {
      const pcm = processAll(a.pcm, a.trimStart, a.trimEnd, a.delayMs, a.speed, a.eq);
      return { pcm, waveform: generateClockWaveform(pcm) };
    }
    case "processClip": {
      const pcmA = processAll(a.pcm, a.trimStart, a.trimEnd, a.delayMs, a.speed, a.eqA);
      const pcmB = processAll(a.pcm, a.trimStart, a.trimEnd, a.delayMs, a.speed, a.eqB);
      return { pcmA, waveA: generateSimpleWaveform(pcmA), pcmB, waveB: generateSimpleWaveform(pcmB) };
    }
    case "crop": {
      const pcm = crop(a.pcm, a.trimStart, a.trimEnd);
      return pcm ? { pcm, wave: generateSimpleWaveform(pcm) } : { pcm: null };
    }
    case "clockWave":
      return { waveform: generateClockWaveform(a.pcm) };
    case "simpleWave":
      return { wave: generateSimpleWaveform(a.pcm) };
    default:
      throw new Error("Unknown DSP op: " + op);
  }
}
