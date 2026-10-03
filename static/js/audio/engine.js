// Port AudioPlayer.kt na Web Audio API.
// Każde odtwarzanie ma identyfikator (jak clockId w Androidzie) i własny GainNode,
// dzięki czemu głośność może być zmieniana w czasie rzeczywistym.
import { SAMPLE_RATE, lowPassFrequency } from "./dsp.js";

const bufferCache = new WeakMap();

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.duckGain = null;
    this.buses = {};
    this.active = new Map(); // id -> { src, gain, filter }
    this.volumes = new Map();
    this._unlockBound = () => this.unlock();
  }

  /** Tworzy AudioContext (leniwie) i przypina odblokowanie dźwięku do gestów użytkownika. */
  init() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.duckGain = this.ctx.createGain();
    this.master.connect(this.duckGain);
    this.duckGain.connect(this.ctx.destination);
    for (const name of ["studio", "chronos", "preview", "metronome"]) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.buses[name] = g;
    }
    this.setSessionType("playback");
    ["pointerdown", "touchend", "keydown"].forEach((ev) =>
      window.addEventListener(ev, this._unlockBound, { capture: true, passive: true }));
    return this.ctx;
  }

  get running() { return this.ctx?.state === "running"; }

  async unlock() {
    if (!this.ctx) this.init();
    if (this.ctx.state !== "running") {
      try { await this.ctx.resume(); } catch (_) { /* ignore */ }
    }
    return this.ctx.state === "running";
  }

  /** iOS 16.4+/Safari: kategoria sesji audio (dźwięk mimo przełącznika wyciszenia). */
  setSessionType(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) { /* ignore */ }
  }

  now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  bufferFor(pcm) {
    if (!pcm || pcm.length === 0) return null;
    let buf = bufferCache.get(pcm);
    if (buf) return buf;
    this.init();
    buf = this.ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    bufferCache.set(pcm, buf);
    return buf;
  }

  /**
   * Odtwarza PCM. Zastępuje poprzednie odtwarzanie o tym samym id (jak AudioPlayer.playRawPcm).
   * @param {string} id
   * @param {Int16Array} pcm
   * @param {number} volume
   * @param {{bus?:string, offsetSec?:number, when?:number, lowpass?:number, onEnded?:Function}} opts
   */
  play(id, pcm, volume = 1, opts = {}) {
    if (!pcm || pcm.length === 0) return null;
    this.init();
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    this.stop(id);
    const buffer = this.bufferFor(pcm);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    this.volumes.set(id, volume);
    let node = src;
    let filter = null;
    if (opts.lowpass != null && opts.lowpass < 0.95) {
      filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = lowPassFrequency(opts.lowpass);
      filter.Q.value = 0.707;
      node.connect(filter);
      node = filter;
    }
    node.connect(gain);
    gain.connect(this.buses[opts.bus || "studio"] || this.master);
    const when = opts.when ? Math.max(opts.when, this.ctx.currentTime) : 0;
    const offset = Math.max(0, Math.min(opts.offsetSec || 0, buffer.duration));
    const entry = { src, gain, filter };
    src.onended = () => {
      if (this.active.get(id) === entry) this.active.delete(id);
      try { gain.disconnect(); } catch (_) { /* ignore */ }
      opts.onEnded?.();
    };
    src.start(when, offset);
    this.active.set(id, entry);
    return entry;
  }

  stop(id) {
    const e = this.active.get(id);
    if (!e) return;
    this.active.delete(id);
    try { e.src.onended = null; e.src.stop(); } catch (_) { /* ignore */ }
    try { e.gain.disconnect(); } catch (_) { /* ignore */ }
  }

  stopPrefix(prefix) {
    for (const id of [...this.active.keys()]) if (id.startsWith(prefix)) this.stop(id);
  }

  isPlaying(id) { return this.active.has(id); }

  /** Odpowiednik AudioPlayer.setRealTimeVolume */
  setRealTimeVolume(id, volume) {
    this.volumes.set(id, volume);
    const e = this.active.get(id);
    if (e && this.ctx) e.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01);
  }

  setBusGain(bus, value) {
    this.init();
    const g = this.buses[bus];
    if (g) g.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  /** Wyciszanie tła podczas nagrywania (Smart Ducking). 1.0 = brak wyciszenia. */
  setDucking(value) {
    this.init();
    this.duckGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
  }

  /** Klik metronomu. */
  click(when = 0, accent = false) {
    this.init();
    if (this.ctx.state !== "running") return;
    const t = Math.max(when, this.ctx.currentTime);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1100;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(g);
    g.connect(this.buses.metronome);
    osc.start(t);
    osc.stop(t + 0.08);
  }
}

export const engine = new AudioEngine();
