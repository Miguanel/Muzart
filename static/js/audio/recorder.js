// Port AudioRecorder.kt — nagrywanie z mikrofonu do PCM 16-bit mono 44.1 kHz.
import { engine } from "./engine.js";
import { processAudioChunk } from "./analyzer.js";
import { floatToInt16, resampleFloat } from "./decoder.js";
import { SAMPLE_RATE } from "./dsp.js";

export class MicUnavailableError extends Error {}
export class MicDeniedError extends Error {}

export class AudioRecorder {
  constructor() {
    this.isRecording = false;
    this.chunks = [];
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.onPoint = null;
    this.analysisBuf = [];
    this.analysisLen = 0;
  }

  /**
   * @param {{useAec?: boolean, onNewPoint?: (p)=>void}} opts
   */
  async start({ useAec = false, onNewPoint = null } = {}) {
    if (this.isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new MicUnavailableError("getUserMedia unavailable");
    const ctx = engine.init();
    await engine.unlock();
    engine.setSessionType("play-and-record");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: useAec,
          noiseSuppression: useAec,
          autoGainControl: false,
        },
      });
    } catch (e) {
      engine.setSessionType("playback");
      if (e?.name === "NotAllowedError" || e?.name === "SecurityError") throw new MicDeniedError(e.message);
      throw new MicUnavailableError(e?.message || String(e));
    }
    this.chunks = [];
    this.analysisBuf = [];
    this.analysisLen = 0;
    this.onPoint = onNewPoint;
    this.sampleRate = ctx.sampleRate;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    const handleChunk = (f32) => {
      if (!this.isRecording) return;
      this.chunks.push(f32);
      if (this.onPoint) {
        this.analysisBuf.push(f32);
        this.analysisLen += f32.length;
        // ~ co 2048 próbek: jeden punkt wizualizacji (jak bufor AudioRecord w Androidzie)
        if (this.analysisLen >= 2048) {
          const merged = new Float32Array(this.analysisLen);
          let o = 0;
          for (const c of this.analysisBuf) { merged.set(c, o); o += c.length; }
          this.analysisBuf = []; this.analysisLen = 0;
          try { this.onPoint(processAudioChunk(merged)); } catch (e) { console.error(e); }
        }
      }
    };

    let usedWorklet = false;
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        if (!engine._recorderModuleLoaded) {
          await ctx.audioWorklet.addModule(new URL("./recorder-worklet.js", import.meta.url));
          engine._recorderModuleLoaded = true;
        }
        this.node = new AudioWorkletNode(ctx, "muzart-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        this.node.port.onmessage = (e) => handleChunk(e.data);
        usedWorklet = true;
      } catch (e) {
        console.warn("AudioWorklet unavailable, using ScriptProcessor", e);
      }
    }
    if (!usedWorklet) {
      this.node = ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (e) => handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.isRecording = true;
  }

  /** Zatrzymuje nagrywanie i zwraca Int16Array (44.1 kHz mono). */
  async stop() {
    if (!this.isRecording) return new Int16Array(0);
    if (this.node?.port) {
      this.node.port.postMessage("flush");
      await new Promise((r) => setTimeout(r, 30));
    }
    this.isRecording = false;
    try { this.source?.disconnect(); } catch (_) { /* ignore */ }
    try { this.node?.disconnect(); } catch (_) { /* ignore */ }
    try { this.sink?.disconnect(); } catch (_) { /* ignore */ }
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    engine.setSessionType("playback");

    let total = 0;
    for (const c of this.chunks) total += c.length;
    const merged = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { merged.set(c, o); o += c.length; }
    this.chunks = [];
    const resampled = this.sampleRate === SAMPLE_RATE ? merged : await resampleFloat(merged, this.sampleRate, SAMPLE_RATE);
    return floatToInt16(resampled);
  }
}
