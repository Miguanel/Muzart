// Port ChronosViewModel.kt — liniowa oś czasu (korytarze, klipy, Breakery, Startery).
import { Emitter, uuid, debounce } from "../util.js";
import { t } from "../i18n.js";
import { engine } from "../audio/engine.js";
import { AudioRecorder } from "../audio/recorder.js";
import { decodeAudioFile } from "../audio/decoder.js";
import { generateSimpleWaveform } from "../audio/analyzer.js";
import { dsp } from "../audio/dsp-client.js";
import { SAMPLE_RATE } from "../audio/dsp.js";
import { kv, projects } from "../storage.js";
import { encodeProject, decodeProject } from "./project-file.js";

export const ToolMode = { PAN: "PAN", MOVE: "MOVE", MULTI_SELECT: "MULTI_SELECT" };

export function createClip(props) {
  return {
    id: uuid(), trackId: null, audioSourceId: "", startBeat: 0, durationBeats: 1,
    pcmData: null, originalPcmData: null, waveformData: null,
    eqBands: [1, 1, 1, 1, 1], trimStart: 0, trimEnd: 1, delayMs: 0, speedFactor: 1,
    isMuted: false, linkedMarkerId: null, linkedMarkerAction: "TOGGLE",
    altEqBands: [1, 1, 1, 1, 1], altPcmData: null, altWaveformData: null,
    linkedEqMarkerId: null, activeEqProfile: "A",
    ...props,
  };
}

export const createLoopMarker = (beat, maxLoops = -1) => ({ id: uuid(), beat, maxLoops, currentLoops: 0 });
export const createStarterMarker = (beat, maxLoops = -1) => ({ id: uuid(), beat, maxLoops, currentLoops: 0 });

function defaultTimeline(keep = {}) {
  return {
    bpm: 120, isPlaying: false, isRecording: false, currentPlayheadBeat: 0,
    masterVolume: 1, secondaryVolume: 1, gridResolution: 0.25, isMetronomeEnabled: false,
    loopMarkers: [createLoopMarker(20, -1)], starterMarkers: [],
    ...keep,
  };
}

class ChronosStore extends Emitter {
  constructor() {
    super();
    this.state = {
      tracks: [],
      clips: [],
      timeline: defaultTimeline(),
      toolMode: ToolMode.PAN,
      selectedTrackId: null,
      recordingTrackId: null,
      recordingStartBeat: 0,
      playingClipId: null,
      selectedClipIds: new Set(),
      isImporting: false,
      projectName: t("default_project_name"),
      savedProjectsList: [],
      isGlobalPlaying: false,
    };
    this.recorder = new AudioRecorder();
    this.playbackRaf = null;
    this.recordingStartTime = 0;
    this._persist = debounce(() => this.saveSession(), 700);
    this._nextClickBeat = null;
  }

  get s() { return this.state; }
  get tl() { return this.state.timeline; }

  set(patch, { persist = true } = {}) {
    Object.assign(this.state, patch);
    this.emit("change", patch);
    if (persist && ("tracks" in patch || "clips" in patch || "projectName" in patch)) this._persist();
  }

  setTimeline(patch, opts) {
    this.set({ timeline: { ...this.state.timeline, ...patch } }, opts);
    if (opts?.persist !== false && ("loopMarkers" in patch || "starterMarkers" in patch || "bpm" in patch || "masterVolume" in patch || "gridResolution" in patch)) this._persist();
  }

  updateClips(fn) { this.set({ clips: fn(this.state.clips) }); }

  // ---------------- Sesja (autozapis) ----------------

  async restoreSession() {
    try {
      const sess = await kv.get("chronos_session");
      if (!sess?.tracks?.length) return false;
      this.set({
        tracks: sess.tracks,
        clips: sess.clips.map((c) => createClip(c)),
        projectName: sess.projectName || this.state.projectName,
        timeline: defaultTimeline({ ...sess.timeline, isPlaying: false, isRecording: false, currentPlayheadBeat: 0 }),
      }, { persist: false });
      return true;
    } catch (e) { console.error(e); return false; }
  }

  async saveSession() {
    try {
      const tl = this.state.timeline;
      await kv.set("chronos_session", {
        tracks: this.state.tracks,
        clips: this.state.clips,
        projectName: this.state.projectName,
        timeline: {
          bpm: tl.bpm, masterVolume: tl.masterVolume, secondaryVolume: tl.secondaryVolume,
          gridResolution: tl.gridResolution, isMetronomeEnabled: tl.isMetronomeEnabled,
          loopMarkers: tl.loopMarkers, starterMarkers: tl.starterMarkers,
        },
      });
    } catch (e) { console.warn("chronos session save failed", e); }
  }

  ensureDefaultTracks() {
    if (this.state.tracks.length === 0) {
      const tracks = [];
      for (let i = 1; i <= 9; i++) tracks.push({ id: uuid(), name: `${t("track_default")} ${i}` });
      this.set({ tracks });
    }
  }

  // ---------------- Zaznaczenie / narzędzia ----------------

  toggleClipSelection(id) {
    const s = new Set(this.state.selectedClipIds);
    s.has(id) ? s.delete(id) : s.add(id);
    this.set({ selectedClipIds: s }, { persist: false });
  }
  clearSelection() { this.set({ selectedClipIds: new Set() }, { persist: false }); }
  selectClip(id) { this.set({ selectedClipIds: id ? new Set([id]) : new Set() }, { persist: false }); }
  selectTrack(id) { this.set({ selectedTrackId: id }, { persist: false }); }
  setToolMode(mode) { this.set({ toolMode: mode }, { persist: false }); }
  setProjectName(name) { this.set({ projectName: name }); }

  // ---------------- Projekty (.mzt) ----------------

  async loadSavedProjectsList() {
    try {
      const names = await projects.list();
      this.set({ savedProjectsList: names.sort((a, b) => a.localeCompare(b)) }, { persist: false });
    } catch (e) { console.error(e); }
  }

  async buildProjectBlob(name = this.state.projectName) {
    const tl = this.state.timeline;
    return encodeProject({
      name,
      tracks: this.state.tracks,
      clips: this.state.clips,
      bpm: tl.bpm, masterVolume: tl.masterVolume, secondaryVolume: tl.secondaryVolume,
      loopMarkers: tl.loopMarkers, starterMarkers: tl.starterMarkers,
    });
  }

  async saveProject() {
    const name = this.state.projectName.trim();
    if (!name) return false;
    const blob = await this.buildProjectBlob(name);
    await projects.put(name, blob);
    await this.loadSavedProjectsList();
    return true;
  }

  async loadProject(name) {
    const rec = await projects.get(name);
    if (!rec) return false;
    const data = await decodeProject(rec.blob);
    this.applyProject(data);
    return true;
  }

  applyProject(data) {
    this.stopPlaybackLoop();
    this.stopGlobalAudioPlayback();
    const clips = data.clips.map((c) => createClip({
      ...c,
      waveformData: c.pcmData ? generateSimpleWaveform(c.pcmData) : null,
      originalPcmData: c.pcmData,
      altWaveformData: c.altPcmData ? generateSimpleWaveform(c.altPcmData) : null,
    }));
    this.set({
      projectName: data.name,
      tracks: data.tracks,
      clips,
      isGlobalPlaying: false,
      selectedClipIds: new Set(),
      selectedTrackId: null,
      timeline: defaultTimeline({
        bpm: data.bpm, masterVolume: data.masterVolume, secondaryVolume: data.secondaryVolume,
        loopMarkers: data.loopMarkers, starterMarkers: data.starterMarkers,
        gridResolution: this.tl.gridResolution, isMetronomeEnabled: this.tl.isMetronomeEnabled,
      }),
    });
    this.applyBusVolumes();
  }

  async exportProject(name) {
    const rec = await projects.get(name);
    return rec?.blob || null;
  }

  async importProjectFile(file) {
    const data = await decodeProject(file);
    let name = (file.name || `Imported_${Date.now()}`).replace(/\.(mzt|zip)$/i, "");
    await projects.put(name, await encodeProject({ ...data, name }));
    await this.loadSavedProjectsList();
    return name;
  }

  async deleteProject(name) {
    await projects.del(name);
    await this.loadSavedProjectsList();
  }

  clearProject() {
    this.stopPlaybackLoop();
    this.stopGlobalAudioPlayback();
    const tl = this.tl;
    this.set({
      clips: [],
      isGlobalPlaying: false,
      selectedClipIds: new Set(),
      timeline: defaultTimeline({ bpm: tl.bpm, masterVolume: tl.masterVolume, secondaryVolume: tl.secondaryVolume, gridResolution: tl.gridResolution }),
    });
  }

  // ---------------- Odtwarzanie ----------------

  applyBusVolumes() {
    engine.setBusGain("chronos", this.tl.masterVolume);
    engine.setBusGain("metronome", this.tl.secondaryVolume);
  }

  togglePlayback() {
    const next = !this.tl.isPlaying;
    engine.unlock();
    this.setTimeline({ isPlaying: next }, { persist: false });
    this.set({ isGlobalPlaying: next }, { persist: false });
    if (next) { this.startPlaybackLoop(); this.startGlobalAudioPlayback(); }
    else { this.stopPlaybackLoop(); this.stopGlobalAudioPlayback(); }
  }

  playFromStartAndReset() {
    engine.unlock();
    this.stopPlaybackLoop();
    this.stopGlobalAudioPlayback();
    const endBeat = this.state.clips.reduce((m, c) => Math.max(m, c.startBeat + c.durationBeats), 0);
    this.setTimeline({ currentPlayheadBeat: 0, isPlaying: true }, { persist: false });
    this.set({ isGlobalPlaying: true }, { persist: false });
    this.startPlaybackLoop(endBeat);
    this.startGlobalAudioPlayback();
  }

  /** Planowanie wszystkich klipów w zegarze AudioContext (dokładniejsze niż delay()). */
  startGlobalAudioPlayback() {
    this.stopGlobalAudioPlayback();
    engine.init();
    this.applyBusVolumes();
    const current = this.tl.currentPlayheadBeat;
    const secPerBeat = 60 / this.tl.bpm;
    const now = engine.now() + 0.03;
    for (const clip of this.state.clips) {
      if (clip.isMuted) continue;
      const pcm = clip.activeEqProfile === "B" && clip.altPcmData ? clip.altPcmData : clip.pcmData;
      if (!pcm) continue;
      if (current >= clip.startBeat + clip.durationBeats) continue;
      const offsetBeats = clip.startBeat - current;
      if (offsetBeats > 0) engine.play(`GLOBAL_${clip.id}`, pcm, 1, { bus: "chronos", when: now + offsetBeats * secPerBeat });
      else engine.play(`GLOBAL_${clip.id}`, pcm, 1, { bus: "chronos", when: now, offsetSec: -offsetBeats * secPerBeat });
    }
  }

  stopGlobalAudioPlayback() { engine.stopPrefix("GLOBAL_"); }

  restartAudioSoon() {
    if (!this.state.isGlobalPlaying) return;
    this.stopGlobalAudioPlayback();
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => { if (this.state.isGlobalPlaying) this.startGlobalAudioPlayback(); }, 50);
  }

  seekToBeat(beat) {
    this.setTimeline({ currentPlayheadBeat: Math.max(0, beat) }, { persist: false });
    this.restartAudioSoon();
  }

  startPlaybackLoop(stopAtBeat = -1) {
    this.stopPlaybackLoop();
    let last = performance.now();
    this._nextClickBeat = Math.ceil(this.tl.currentPlayheadBeat);
    const step = () => {
      const now = performance.now();
      const deltaMs = Math.min(250, now - last); // ochrona przed skokiem po uśpieniu karty
      last = now;
      const tl = this.tl;
      const current = tl.currentPlayheadBeat;
      const next = current + deltaMs * (tl.bpm / 60000);

      const crossed = tl.loopMarkers.filter((m) => m.beat > current && m.beat <= next).sort((a, b) => a.beat - b.beat)[0];
      if (crossed) {
        const exhausted = crossed.maxLoops !== -1 && crossed.currentLoops + 1 >= crossed.maxLoops;
        const updatedMarkers = tl.loopMarkers.map((m) => (m.id === crossed.id ? { ...m, currentLoops: m.currentLoops + 1 } : m));
        this.updateClips((clips) => clips.map((c) => {
          let mc = c;
          if (c.linkedMarkerId === crossed.id) {
            const muted = c.linkedMarkerAction === "MUTE" ? true : c.linkedMarkerAction === "UNMUTE" ? false : !c.isMuted;
            mc = { ...mc, isMuted: muted };
          }
          if (c.linkedEqMarkerId === crossed.id && c.altPcmData) mc = { ...mc, activeEqProfile: c.activeEqProfile === "A" ? "B" : "A" };
          return mc;
        }));
        if (exhausted) {
          this.setTimeline({ currentPlayheadBeat: next, loopMarkers: updatedMarkers.filter((m) => m.id !== crossed.id) }, { persist: false });
        } else {
          const starter = tl.starterMarkers.filter((s) => s.beat <= crossed.beat).sort((a, b) => b.beat - a.beat)[0];
          let jump = 0;
          let starters = tl.starterMarkers;
          if (starter) {
            jump = starter.beat;
            const sEx = starter.maxLoops !== -1 && starter.currentLoops + 1 >= starter.maxLoops;
            starters = starters.map((s) => (s.id === starter.id ? { ...s, currentLoops: s.currentLoops + 1 } : s));
            if (sEx) starters = starters.filter((s) => s.id !== starter.id);
          }
          this.setTimeline({ currentPlayheadBeat: jump, loopMarkers: updatedMarkers, starterMarkers: starters }, { persist: false });
          this._nextClickBeat = Math.ceil(jump);
          this.restartAudioSoon();
        }
      } else if (stopAtBeat > 0 && next >= stopAtBeat) {
        this.setTimeline({ currentPlayheadBeat: 0, isPlaying: false }, { persist: false });
        this.set({ isGlobalPlaying: false }, { persist: false });
        this.stopGlobalAudioPlayback();
        this.playbackRaf = null;
        return;
      } else {
        this.setTimeline({ currentPlayheadBeat: next }, { persist: false });
      }

      // Metronom (Chronometr) — klik na każdy pełny bit
      if (this.tl.isMetronomeEnabled && this._nextClickBeat != null && this.tl.currentPlayheadBeat >= this._nextClickBeat) {
        engine.click(0, this._nextClickBeat % 4 === 0);
        this._nextClickBeat = Math.floor(this.tl.currentPlayheadBeat) + 1;
      }
      this.playbackRaf = requestAnimationFrame(step);
    };
    this.playbackRaf = requestAnimationFrame(step);
  }

  stopPlaybackLoop() {
    if (this.playbackRaf) cancelAnimationFrame(this.playbackRaf);
    this.playbackRaf = null;
  }

  // ---------------- Nagrywanie na korytarz ----------------

  async startTrackRecording(trackId) {
    if (this.state.recordingTrackId) return;
    await engine.unlock();
    await this.recorder.start({ useAec: true });
    this.recordingStartTime = performance.now();
    this.set({ recordingTrackId: trackId, recordingStartBeat: this.tl.currentPlayheadBeat }, { persist: false });
    this.setTimeline({ isRecording: true }, { persist: false });
    if (!this.tl.isPlaying) {
      this.setTimeline({ isPlaying: true }, { persist: false });
      this.startPlaybackLoop();
    }
  }

  async stopTrackRecording(trackId) {
    if (this.state.recordingTrackId !== trackId) return;
    const pcm = await this.recorder.stop();
    const startBeat = this.state.recordingStartBeat;
    this.set({ recordingTrackId: null }, { persist: false });
    this.setTimeline({ isRecording: false, isPlaying: false }, { persist: false });
    this.stopPlaybackLoop();
    if (this.state.isGlobalPlaying) { this.stopGlobalAudioPlayback(); this.set({ isGlobalPlaying: false }, { persist: false }); }
    if (pcm.length) {
      const durationMs = (pcm.length / SAMPLE_RATE) * 1000;
      const clip = createClip({
        trackId, audioSourceId: `recording_${uuid()}`, startBeat,
        durationBeats: durationMs * (this.tl.bpm / 60000),
        pcmData: pcm, originalPcmData: pcm, waveformData: generateSimpleWaveform(pcm),
      });
      this.addClip(clip);
    }
  }

  // ---------------- Edycja klipów ----------------

  async applyAdvancedAudioProcessing(clipId, trimStart, trimEnd, delayMs, speedFactor, eqA, eqB, linkedEqMarkerId) {
    const clip = this.state.clips.find((c) => c.id === clipId);
    const original = clip?.originalPcmData || clip?.pcmData;
    if (!original) return;
    const r = await dsp("processClip", { pcm: original, trimStart, trimEnd, delayMs, speed: speedFactor, eqA: Array.from(eqA), eqB: Array.from(eqB) });
    const durationMs = Math.max(10, (r.pcmA.length / SAMPLE_RATE) * 1000);
    this.updateClips((clips) => clips.map((c) => (c.id === clipId ? {
      ...c, pcmData: r.pcmA, waveformData: r.waveA, durationBeats: durationMs * (this.tl.bpm / 60000),
      trimStart, trimEnd, delayMs, speedFactor, eqBands: Array.from(eqA), altEqBands: Array.from(eqB),
      altPcmData: r.pcmB, altWaveformData: r.waveB, linkedEqMarkerId, activeEqProfile: "A",
      originalPcmData: c.originalPcmData || original,
    } : c)));
  }

  async cropClipPermanently(clipId, trimStart, trimEnd) {
    const clip = this.state.clips.find((c) => c.id === clipId);
    const src = clip?.originalPcmData || clip?.pcmData;
    if (!src) return;
    const r = await dsp("crop", { pcm: src, trimStart, trimEnd });
    if (!r.pcm) return;
    const durationMs = Math.max(10, (r.pcm.length / SAMPLE_RATE) * 1000);
    this.updateClips((clips) => clips.map((c) => (c.id === clipId ? {
      ...c, pcmData: r.pcm, originalPcmData: r.pcm, waveformData: r.wave,
      trimStart: 0, trimEnd: 1, durationBeats: durationMs * (this.tl.bpm / 60000),
      altPcmData: null, altWaveformData: null,
    } : c)));
  }

  toggleClipPlayback(clip) {
    if (this.state.playingClipId === clip.id) { engine.stop(`CHR_${clip.id}`); this.set({ playingClipId: null }, { persist: false }); return; }
    if (this.state.playingClipId) engine.stop(`CHR_${this.state.playingClipId}`);
    const pcm = clip.pcmData;
    if (!pcm) return;
    engine.unlock();
    this.set({ playingClipId: clip.id }, { persist: false });
    engine.play(`CHR_${clip.id}`, pcm, 1, {
      bus: "chronos",
      onEnded: () => { if (this.state.playingClipId === clip.id) this.set({ playingClipId: null }, { persist: false }); },
    });
  }

  duplicateClip(id) {
    const c = this.state.clips.find((x) => x.id === id);
    if (!c) return;
    const n = { ...c, id: uuid(), startBeat: c.startBeat + c.durationBeats };
    this.addClip(n);
    this.set({ selectedClipIds: new Set([n.id]) }, { persist: false });
  }

  duplicateSelectedClips() {
    const sel = this.state.selectedClipIds;
    const copies = this.state.clips.filter((c) => sel.has(c.id)).map((c) => ({ ...c, id: uuid(), startBeat: c.startBeat + c.durationBeats }));
    this.updateClips((clips) => [...clips, ...copies]);
    this.set({ selectedClipIds: new Set(copies.map((c) => c.id)) }, { persist: false });
  }

  deleteSelectedClips() {
    const sel = this.state.selectedClipIds;
    this.updateClips((clips) => clips.filter((c) => !sel.has(c.id)));
    this.clearSelection();
  }

  moveSelectedClips(primaryId, newBeat, newTrackId) {
    const tracks = this.state.tracks;
    const primary = this.state.clips.find((c) => c.id === primaryId);
    if (!primary) return;
    const pIdx = tracks.findIndex((t) => t.id === primary.trackId);
    const nIdx = tracks.findIndex((t) => t.id === newTrackId);
    const beatDelta = newBeat - primary.startBeat;
    const trackDelta = nIdx - pIdx;
    const sel = this.state.selectedClipIds;
    this.updateClips((clips) => clips.map((c) => {
      if (!sel.has(c.id)) return c;
      const ci = tracks.findIndex((t) => t.id === c.trackId);
      const ti = Math.min(tracks.length - 1, Math.max(0, ci + trackDelta));
      return { ...c, startBeat: Math.max(0, c.startBeat + beatDelta), trackId: tracks[ti].id };
    }));
  }

  updateClipPosition(id, startBeat, trackId) {
    this.updateClips((clips) => clips.map((c) => (c.id === id ? { ...c, startBeat, trackId: trackId || c.trackId } : c)));
  }

  addClip(clip) { this.updateClips((clips) => [...clips, clip]); }
  removeClip(id) { this.updateClips((clips) => clips.filter((c) => c.id !== id)); this.clearSelection(); }

  toggleClipMute(id) {
    this.updateClips((clips) => clips.map((c) => (c.id === id ? { ...c, isMuted: !c.isMuted } : c)));
    this.restartAudioSoon();
  }

  linkClipToMarker(id, markerId, action) {
    this.updateClips((clips) => clips.map((c) => (c.id === id ? { ...c, linkedMarkerId: markerId, linkedMarkerAction: action } : c)));
  }

  // ---------------- Korytarze ----------------

  addTrackWithId(id, name) { this.set({ tracks: [...this.state.tracks, { id, name }] }); }

  renameTrack(id, name) { this.set({ tracks: this.state.tracks.map((t) => (t.id === id ? { ...t, name } : t)) }); }

  moveTrack(id, up) {
    const list = this.state.tracks.slice();
    const i = list.findIndex((t) => t.id === id);
    const j = up ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.set({ tracks: list });
  }

  removeTrack(id) {
    this.set({ tracks: this.state.tracks.filter((t) => t.id !== id), clips: this.state.clips.filter((c) => c.trackId !== id), selectedTrackId: null });
  }

  async importAudioClip(trackId, file) {
    this.set({ isImporting: true }, { persist: false });
    try {
      let { pcm, durationMs } = await decodeAudioFile(file);
      if (durationMs <= 0) durationMs = pcm.length / 44.1;
      const clip = createClip({
        trackId, audioSourceId: file.name, startBeat: 0,
        durationBeats: durationMs * (this.tl.bpm / 60000),
        pcmData: pcm, originalPcmData: pcm, waveformData: generateSimpleWaveform(pcm),
      });
      this.addClip(clip);
      return true;
    } finally {
      this.set({ isImporting: false }, { persist: false });
    }
  }

  // ---------------- Transport / znaczniki ----------------

  setMasterVolume(v) { this.setTimeline({ masterVolume: v }); engine.setBusGain("chronos", v); }
  setSecondaryVolume(v) { this.setTimeline({ secondaryVolume: v }); engine.setBusGain("metronome", v); }
  setGridResolution(r) { this.setTimeline({ gridResolution: r }); }
  setBpm(bpm) {
    // Zmiana tempa przelicza długości klipów (czas audio pozostaje ten sam).
    const old = this.tl.bpm;
    bpm = Math.min(300, Math.max(20, bpm));
    const ratio = bpm / old;
    this.updateClips((clips) => clips.map((c) => ({ ...c, durationBeats: c.durationBeats * ratio, startBeat: c.startBeat * ratio })));
    this.setTimeline({
      bpm,
      currentPlayheadBeat: this.tl.currentPlayheadBeat * ratio,
      loopMarkers: this.tl.loopMarkers.map((m) => ({ ...m, beat: m.beat * ratio })),
      starterMarkers: this.tl.starterMarkers.map((m) => ({ ...m, beat: m.beat * ratio })),
    });
    this.restartAudioSoon();
  }
  toggleMetronome() { this.setTimeline({ isMetronomeEnabled: !this.tl.isMetronomeEnabled }); }

  addLoopMarker(beat, maxLoops) { this.setTimeline({ loopMarkers: [...this.tl.loopMarkers, createLoopMarker(beat, maxLoops)] }); }
  updateLoopMarker(id, beat) { this.setTimeline({ loopMarkers: this.tl.loopMarkers.map((m) => (m.id === id ? { ...m, beat } : m)) }); }
  updateLoopMarkerConfig(id, maxLoops) { this.setTimeline({ loopMarkers: this.tl.loopMarkers.map((m) => (m.id === id ? { ...m, maxLoops, currentLoops: 0 } : m)) }); }
  removeLoopMarker(id) {
    this.setTimeline({ loopMarkers: this.tl.loopMarkers.filter((m) => m.id !== id) });
    this.updateClips((clips) => clips.map((c) => ({
      ...c,
      linkedMarkerId: c.linkedMarkerId === id ? null : c.linkedMarkerId,
      linkedEqMarkerId: c.linkedEqMarkerId === id ? null : c.linkedEqMarkerId,
    })));
  }

  addStarterMarker(beat, maxLoops) { this.setTimeline({ starterMarkers: [...this.tl.starterMarkers, createStarterMarker(beat, maxLoops)] }); }
  updateStarterMarker(id, beat) { this.setTimeline({ starterMarkers: this.tl.starterMarkers.map((m) => (m.id === id ? { ...m, beat } : m)) }); }
  updateStarterMarkerConfig(id, maxLoops) { this.setTimeline({ starterMarkers: this.tl.starterMarkers.map((m) => (m.id === id ? { ...m, maxLoops, currentLoops: 0 } : m)) }); }
  removeStarterMarker(id) { this.setTimeline({ starterMarkers: this.tl.starterMarkers.filter((m) => m.id !== id) }); }
}

export const chronos = new ChronosStore();
