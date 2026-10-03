// Port MuzartViewModel.kt — stan Studio, silnik wyzwalania zegarów, biblioteka i playlisty.
import { Emitter, uuid, debounce } from "../util.js";
import { engine } from "../audio/engine.js";
import { AudioRecorder } from "../audio/recorder.js";
import { generateClockWaveform, emptyPoint } from "../audio/analyzer.js";
import { dsp } from "../audio/dsp-client.js";
import { SAMPLE_RATE } from "../audio/dsp.js";
import { kv, prefs } from "../storage.js";
import * as M from "./model.js";

const RESOLUTION = 180;

class StudioStore extends Emitter {
  constructor() {
    super();
    const root = M.createClock({ durationMs: 4000, name: "Root" });
    this.state = {
      rootClock: root,
      selectedClockId: null,
      isRecording: false,
      recordingClockId: null,
      duplicateSourceId: null,
      duplicateTargetId: null,
      duplicateIncludeChildren: false,
      globalTimeMs: 0,
      isEnginePlaying: false,
      engineDelayMs: prefs.get("engine_delay", 8),
      library: [],
      savedPlaylists: [],
      songScenes: [M.createScene("Scene 1", root)],
      currentSceneIndex: 0,
      isSongMode: false,
      showSampleEditor: false,
      duckingPercentage: prefs.get("ducking", 0.1),
      smartDucking: prefs.get("smart_ducking", true),
    };
    this.pendingSceneIndex = null;
    this.recorder = new AudioRecorder();
    this._loop = null;
    this._persistSession = debounce(() => this.saveSession(), 700);
  }

  get s() { return this.state; }

  /** Aktualizacja stanu; `silent` = bez zapisu sesji (np. tyknięcia silnika). */
  set(patch, { silent = false } = {}) {
    Object.assign(this.state, patch);
    this.emit("change", patch);
    if (!silent && ("rootClock" in patch || "songScenes" in patch)) this._persistSession();
  }

  updateRoot(fn, opts) {
    const next = fn(this.state.rootClock);
    if (next !== this.state.rootClock) this.set({ rootClock: next }, opts);
    return next;
  }

  getNodeById(id, root = this.state.rootClock) { return M.getNodeById(root, id); }

  // ---------------- Inicjalizacja / sesja ----------------

  async loadLibraryFromDisk() {
    try {
      const lib = (await kv.get("library")) || [];
      const pls = (await kv.get("playlists")) || [];
      this.set({
        library: lib.map(M.normalizeClock),
        savedPlaylists: pls.map((p) => ({ ...p, scenes: p.scenes.map((sc) => ({ ...sc, rootClock: M.normalizeClock(sc.rootClock) })) })),
      }, { silent: true });
    } catch (e) { console.error(e); }
  }

  async saveLibraryToDisk() {
    try {
      await kv.set("library", this.state.library.map(M.stripRuntime));
      await kv.set("playlists", this.state.savedPlaylists.map((p) => ({
        ...p, scenes: p.scenes.map((sc) => ({ ...sc, rootClock: M.stripRuntime(sc.rootClock) })),
      })));
    } catch (e) { console.error(e); this.emit("error", e); }
  }

  async restoreSession() {
    try {
      const sess = await kv.get("studio_session");
      if (!sess?.rootClock) return false;
      const root = M.updateRecursiveCounts(M.normalizeClock(sess.rootClock));
      const scenes = (sess.songScenes || []).map((sc) => ({ ...M.createScene(sc.name, root), ...sc, rootClock: M.normalizeClock(sc.rootClock) }));
      this.set({
        rootClock: root,
        songScenes: scenes.length ? scenes : [M.createScene("Scene 1", root)],
        currentSceneIndex: Math.min(sess.currentSceneIndex || 0, Math.max(0, scenes.length - 1)),
      }, { silent: true });
      return true;
    } catch (e) { console.error(e); return false; }
  }

  async saveSession() {
    try {
      await kv.set("studio_session", {
        rootClock: M.stripRuntime(this.state.rootClock),
        songScenes: this.state.songScenes.map((sc) => ({ ...sc, rootClock: M.stripRuntime(sc.rootClock) })),
        currentSceneIndex: this.state.currentSceneIndex,
      });
    } catch (e) { console.warn("session save failed", e); }
  }

  // ---------------- Ustawienia ----------------

  setEngineDelay(ms) { prefs.set("engine_delay", ms); this.set({ engineDelayMs: ms }); }
  setDuckingPercentage(p) { p = Math.min(1, Math.max(0, p)); prefs.set("ducking", p); this.set({ duckingPercentage: p }); }
  setSmartDucking(on) { prefs.set("smart_ducking", on); this.set({ smartDucking: on }); }
  setShowSampleEditor(v) { this.set({ showSampleEditor: v }); }
  selectClock(id) { this.set({ selectedClockId: id }); }

  // ---------------- Projekt ----------------

  newProject() {
    this.stopSongSequence();
    this.stopAllAudio();
    const root = M.createClock({ durationMs: 4000, name: "Root" });
    this.set({
      rootClock: root,
      songScenes: [M.createScene("Scene 1", root)],
      currentSceneIndex: 0,
      selectedClockId: null,
      globalTimeMs: 0,
      isEnginePlaying: false,
    });
  }

  stopAllAudio() {
    for (const id of [...engine.active.keys()]) if (!id.startsWith("GLOBAL_") && !id.startsWith("CHR_")) engine.stop(id);
  }

  // ---------------- Głośność ----------------

  applyRealTimeVolumes(root) {
    engine.setRealTimeVolume(root.id, root.isMuted ? 0 : root.volumeModifier);
    const rec = (node, inherited) => {
      for (const child of node.children) {
        const pass = inherited * M.childModifier(node, child);
        engine.setRealTimeVolume(child.id, (child.isMuted ? 0 : child.volumeModifier) * pass);
        rec(child, pass);
      }
    };
    rec(root, 1);
  }

  _updateWithVolumes(id, fn) {
    const root = this.updateRoot((r) => M.updateNodeInTree(r, id, fn));
    this.applyRealTimeVolumes(root);
  }

  setVolume(id, v) { this._updateWithVolumes(id, (n) => ({ ...n, volumeModifier: v, isMuted: v === 0 })); }

  toggleMute(id) {
    this._updateWithVolumes(id, (n) => (n.isMuted || n.volumeModifier === 0)
      ? { ...n, isMuted: false, volumeModifier: n.previousVolume > 0 ? n.previousVolume : 1 }
      : { ...n, isMuted: true, previousVolume: n.volumeModifier, volumeModifier: 0 });
  }

  setChildrenVolume(id, v) { this._updateWithVolumes(id, (n) => ({ ...n, childrenVolumeModifier: v, isChildrenMuted: v === 0 })); }

  toggleChildrenMute(id) {
    this._updateWithVolumes(id, (n) => (n.isChildrenMuted || n.childrenVolumeModifier === 0)
      ? { ...n, isChildrenMuted: false, childrenVolumeModifier: n.previousChildrenVolume > 0 ? n.previousChildrenVolume : 1 }
      : { ...n, isChildrenMuted: true, previousChildrenVolume: n.childrenVolumeModifier, childrenVolumeModifier: 0 });
  }

  toggleChildVolumeExclusion(parentId, childId) {
    this._updateWithVolumes(parentId, (p) => ({
      ...p,
      volumeExcludedChildren: p.volumeExcludedChildren.includes(childId)
        ? p.volumeExcludedChildren.filter((x) => x !== childId)
        : [...p.volumeExcludedChildren, childId],
    }));
  }

  saveVolumePreset(parentId, slot) {
    this.updateRoot((r) => M.updateNodeInTree(r, parentId, (p) => ({
      ...p, volumePresets: { ...p.volumePresets, [slot]: { name: `SAVE ${slot + 1}`, excludedIds: [...p.volumeExcludedChildren] } },
    })));
  }

  loadVolumePreset(parentId, slot) {
    this._updateWithVolumes(parentId, (p) => {
      const preset = p.volumePresets[slot];
      return preset ? { ...p, volumeExcludedChildren: [...preset.excludedIds] } : p;
    });
  }

  renameVolumePreset(parentId, slot, name) {
    this.updateRoot((r) => M.updateNodeInTree(r, parentId, (p) => {
      const preset = p.volumePresets[slot];
      return preset ? { ...p, volumePresets: { ...p.volumePresets, [slot]: { ...preset, name } } } : p;
    }));
  }

  deleteVolumePreset(parentId, slot) {
    this.updateRoot((r) => M.updateNodeInTree(r, parentId, (p) => {
      const presets = { ...p.volumePresets };
      delete presets[slot];
      return { ...p, volumePresets: presets };
    }));
  }

  // ---------------- Biblioteka ----------------

  saveClockToLibrary(node, saveName, saveEmoji, includeChildren) {
    const toSave = includeChildren
      ? { ...M.copyNodeRecursive(node), name: saveName, emoji: saveEmoji }
      : { ...node, id: uuid(), name: saveName, emoji: saveEmoji, children: [], recursiveChildrenCount: 0, volumeExcludedChildren: [], volumePresets: {}, editEqBands: [...node.editEqBands], lastTriggeredTimeMs: null };
    this.set({ library: [...this.state.library, M.stripRuntime(toSave)] }, { silent: true });
    return this.saveLibraryToDisk();
  }

  removeFromLibrary(id) {
    this.set({ library: this.state.library.filter((n) => n.id !== id) }, { silent: true });
    this.saveLibraryToDisk();
  }

  savePlaylistToLibrary(name) {
    // Zapisujemy aktualny stan zegara do bieżącej sceny, aby playlista zawierała to, co widać.
    this.saveActiveClockToCurrentScene();
    const pl = M.createPlaylist(name, this.state.songScenes.map((sc) => ({ ...sc, rootClock: M.stripRuntime(M.copyNodeRecursive(sc.rootClock)) })));
    this.set({ savedPlaylists: [...this.state.savedPlaylists, pl] }, { silent: true });
    return this.saveLibraryToDisk();
  }

  removePlaylistFromLibrary(id) {
    this.set({ savedPlaylists: this.state.savedPlaylists.filter((p) => p.id !== id) }, { silent: true });
    this.saveLibraryToDisk();
  }

  loadPlaylistFromLibrary(pl) {
    const scenes = pl.scenes.map((sc) => ({ ...sc, rootClock: M.copyNodeRecursive(sc.rootClock) }));
    const first = scenes[0];
    this.set({
      songScenes: scenes,
      currentSceneIndex: 0,
      rootClock: first ? M.updateRecursiveCounts(M.copyNodeRecursive(first.rootClock)) : this.state.rootClock,
      globalTimeMs: 0,
      selectedClockId: null,
    });
  }

  loadClockFromLibrary(targetId, saved) {
    const copy = M.copyNodeRecursive(saved);
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, targetId, (t) => ({
      ...copy, id: t.id, angleOnParent: t.angleOnParent, radiusRatio: t.radiusRatio, isVisible: true,
    }))));
  }

  // ---------------- Edycja drzewa ----------------

  hideClock(id) {
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, id, (n) => ({ ...n, isVisible: false }))));
    this.set({ selectedClockId: null });
  }

  showAllClocks() { this.updateRoot((r) => M.updateRecursiveCounts(M.setAllVisibilityRecursive(r, true))); }

  deleteClock(id) {
    engine.stop(id);
    if (id === this.state.rootClock.id) {
      this.updateRoot((r) => ({ ...r, children: [], rawAudioData: null, originalRawAudioData: null, waveformData: null, originalWaveformData: null, name: "", emoji: "", isVisible: true, recursiveChildrenCount: 0 }));
    } else {
      this.updateRoot((r) => M.updateRecursiveCounts(M.removeNodeFromTree(r, id) || r));
    }
    this.set({ selectedClockId: null });
  }

  updateClockMeta(id, name, emoji) {
    this.updateRoot((r) => M.updateNodeInTree(r, id, (n) => (n.name === name && n.emoji === emoji ? n : { ...n, name, emoji })));
  }

  splitClock(id, segments) {
    this.updateRoot((r) => M.updateNodeInTree(r, id, (n) => (n.segments === segments ? n : { ...n, segments })));
  }

  addSubClock(parentId, angle, durationMs = 10) {
    const child = M.createClock({ durationMs, angleOnParent: angle });
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, parentId, (p) => ({ ...p, children: [...p.children, child] }))));
  }

  duplicateNodeIntoSlot(sourceId, targetParentId, targetAngle) {
    const root = this.state.rootClock;
    const src = M.getNodeById(root, sourceId);
    if (!src) return;
    const dup = this.state.duplicateIncludeChildren
      ? { ...M.copyNodeRecursive(src), angleOnParent: targetAngle }
      : { ...src, id: uuid(), angleOnParent: targetAngle, children: [], lastTriggeredTimeMs: null, isVisible: true, recursiveChildrenCount: 0, volumeExcludedChildren: [], volumePresets: {}, editEqBands: [...src.editEqBands] };
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, targetParentId, (p) => ({ ...p, children: [...p.children, dup] }))));
  }

  toggleDuplicateMode(sourceId, includeChildren) {
    const s = this.state;
    if (s.duplicateSourceId === sourceId && s.duplicateIncludeChildren === includeChildren) this.cancelDuplicateMode();
    else this.set({ duplicateSourceId: sourceId, duplicateIncludeChildren: includeChildren, duplicateTargetId: null });
  }

  setDuplicateTarget(id) { this.set({ duplicateTargetId: id }); }
  cancelDuplicateMode() { this.set({ duplicateSourceId: null, duplicateTargetId: null, duplicateIncludeChildren: false }); }

  togglePause(id) { this.updateRoot((r) => M.updateNodeInTree(r, id, (n) => ({ ...n, isPaused: !n.isPaused }))); }

  togglePauseAll(id) {
    const node = this.getNodeById(id);
    if (!node) return;
    const next = !node.isPaused;
    this.updateRoot((r) => M.updateNodeInTree(r, id, (n) => M.setPauseRecursive(n, next)));
  }

  // ---------------- Odtwarzanie ręczne ----------------

  playClock(id) {
    const n = this.getNodeById(id);
    const pcm = n?.rawAudioData || n?.originalRawAudioData;
    if (pcm) engine.play(n.id, pcm, n.isMuted ? 0 : n.volumeModifier);
  }

  playClockAll(id) {
    const n = this.getNodeById(id);
    if (!n) return;
    const rec = (node, inherited) => {
      const vol = (node.isMuted ? 0 : node.volumeModifier) * inherited;
      const pcm = node.rawAudioData || node.originalRawAudioData;
      if (pcm) engine.play(node.id, pcm, vol);
      for (const c of node.children) rec(c, inherited * M.childModifier(node, c));
    };
    rec(n, 1);
  }

  // ---------------- Silnik (startPlaybackEngine) ----------------

  togglePlayback() {
    if (this.state.isEnginePlaying) {
      this.updateRoot((r) => M.clearTriggersRecursive(r), { silent: true });
      this.set({ isEnginePlaying: false, globalTimeMs: 0 }, { silent: true });
    } else {
      engine.unlock();
      this.set({ isEnginePlaying: true }, { silent: true });
    }
  }

  startPlaybackEngine() {
    if (this._loop) return;
    let lastReal = performance.now();
    let acc = 0;
    let currentLoop = 0;
    let wasPlaying = false;

    const tick = () => {
      const now = performance.now();
      const delta = Math.round(now - lastReal);
      lastReal = now;
      const s = this.state;

      if (s.isEnginePlaying) {
        if (!wasPlaying) { acc = 0; currentLoop = 0; wasPlaying = true; }
        let root = s.rootClock;
        const duration = Math.max(1, root.durationMs);
        let last = acc;
        acc += Math.max(0, delta);
        const looped = (acc % duration) < (last % duration);

        if (s.isSongMode && looped && s.songScenes.length) {
          const scene = s.songScenes[s.currentSceneIndex];
          currentLoop++;
          let nextIndex = s.currentSceneIndex;
          if (currentLoop >= (scene?.loopCount || 1) || this.pendingSceneIndex != null) {
            nextIndex = this.pendingSceneIndex ?? ((s.currentSceneIndex + 1) % s.songScenes.length);
            this.pendingSceneIndex = null;
            currentLoop = 0;
          }
          if (nextIndex !== s.currentSceneIndex) {
            root = M.updateRecursiveCounts(M.copyNodeRecursive(s.songScenes[nextIndex].rootClock));
            this.set({ currentSceneIndex: nextIndex, rootClock: root }, { silent: true });
            acc = 0; last = 0;
          }
        } else if (this.pendingSceneIndex != null && looped) {
          const nextIndex = this.pendingSceneIndex;
          this.pendingSceneIndex = null;
          root = M.updateRecursiveCounts(M.copyNodeRecursive(s.songScenes[nextIndex].rootClock));
          this.set({ currentSceneIndex: nextIndex, rootClock: root }, { silent: true });
          acc = 0; last = 0; currentLoop = 0;
        }

        const audio = [];
        const scene = this.state.songScenes[this.state.currentSceneIndex];
        const muted = new Set(scene?.mutedDepths || []);
        const active = this.state.rootClock;
        const ad = Math.max(1, active.durationMs);
        const loopLast = last % ad;
        const loopCurr = acc % ad;
        if ((last === 0 || loopLast > loopCurr) && !active.isPaused && !muted.has(0)) {
          const pcm = active.rawAudioData || active.originalRawAudioData;
          if (pcm) audio.push([active.id, pcm, active.isMuted ? 0 : active.volumeModifier]);
        }
        const updated = processTriggers(active, last, acc, true, audio, 1, muted, 0);
        if (updated) this.state.rootClock = updated; // bez emitowania — to tylko znaczniki czasu
        this.state.globalTimeMs = acc;
        this.emit("tick", acc);

        const lp = scene?.masterLowPassFilter ?? 1;
        for (const [id, pcm, vol] of audio) engine.play(id, pcm, vol, { lowpass: lp < 0.95 ? lp : null });
      } else {
        if (wasPlaying) { wasPlaying = false; acc = 0; currentLoop = 0; this.emit("tick", 0); }
      }
      this._loop = setTimeout(tick, this.state.engineDelayMs);
    };
    this._loop = setTimeout(tick, this.state.engineDelayMs);
  }

  // ---------------- Sceny / tryb piosenki ----------------

  saveActiveClockToCurrentScene() {
    const i = this.state.currentSceneIndex;
    const scenes = this.state.songScenes;
    if (i >= 0 && i < scenes.length) {
      const copy = scenes.slice();
      copy[i] = { ...scenes[i], rootClock: M.copyNodeRecursive(this.state.rootClock) };
      this.set({ songScenes: copy });
    }
  }

  addCurrentStateAsScene() {
    const sc = M.createScene(`Scene ${this.state.songScenes.length + 1}`, M.copyNodeRecursive(this.state.rootClock));
    this.set({ songScenes: [...this.state.songScenes, sc] });
  }

  playSongSequence() {
    this.saveActiveClockToCurrentScene();
    const first = this.state.songScenes[0];
    this.set({
      currentSceneIndex: 0,
      rootClock: first ? M.updateRecursiveCounts(M.copyNodeRecursive(first.rootClock)) : this.state.rootClock,
      globalTimeMs: 0, isSongMode: true, isEnginePlaying: true,
    });
  }

  stopSongSequence() { this.set({ isSongMode: false, isEnginePlaying: false, globalTimeMs: 0 }, { silent: true }); }

  selectScene(index) {
    if (index < 0 || index >= this.state.songScenes.length) return;
    this.saveActiveClockToCurrentScene();
    const sc = this.state.songScenes[index];
    this.set({ currentSceneIndex: index, rootClock: M.updateRecursiveCounts(M.copyNodeRecursive(sc.rootClock)), globalTimeMs: 0 });
  }

  // ---------------- Przetwarzanie audio (edytor sampli) ----------------

  async applyAudioProcessing(id, startPercent, endPercent, delayMs, speed, eq) {
    const node = this.getNodeById(id);
    const source = node?.originalRawAudioData || node?.rawAudioData;
    if (!source) return;
    const { pcm, waveform } = await dsp("processClock", { pcm: source, trimStart: startPercent, trimEnd: endPercent, delayMs, speed, eq: Array.from(eq) });
    const newDuration = Math.max(10, Math.floor((pcm.length / SAMPLE_RATE) * 1000));
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, id, (n) => ({
      ...n,
      rawAudioData: pcm,
      originalRawAudioData: n.originalRawAudioData || source,
      durationMs: newDuration,
      waveformData: waveform,
      editTrimStart: startPercent, editTrimEnd: endPercent, editDelayMs: delayMs, editSpeed: speed,
      editEqBands: Array.from(eq),
    }))));
  }

  importAudioToClock(id, pcm, fileName) {
    const duration = Math.max(10, Math.floor((pcm.length / SAMPLE_RATE) * 1000));
    const waveform = generateClockWaveform(pcm, RESOLUTION);
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, id, (n) => ({
      ...n, rawAudioData: pcm, originalRawAudioData: pcm, name: fileName, durationMs: duration,
      waveformData: waveform, originalWaveformData: waveform,
      editTrimStart: 0, editTrimEnd: 1, editDelayMs: 0, editSpeed: 1, editEqBands: [1, 1, 1, 1, 1],
    }))));
  }

  // ---------------- Nagrywanie ----------------

  async startRecordingToClock(id) {
    if (this.state.isRecording) return;
    const startTime = performance.now();
    const blank = Array.from({ length: RESOLUTION }, emptyPoint);
    this.set({ isRecording: true, recordingClockId: id });
    try {
      await this.recorder.start({
        useAec: false,
        onNewPoint: (p) => {
          this.updateRoot((r) => M.updateNodeInTree(r, id, (n) => {
            const wf = (n.originalWaveformData || blank).slice();
            const progress = ((performance.now() - startTime) % Math.max(1, n.durationMs)) / Math.max(1, n.durationMs);
            wf[Math.min(RESOLUTION - 1, Math.max(0, Math.floor(progress * RESOLUTION)))] = p;
            return { ...n, originalWaveformData: wf, waveformData: wf };
          }), { silent: true });
        },
      });
    } catch (e) {
      this.set({ isRecording: false, recordingClockId: null });
      throw e;
    }
    if (this.state.smartDucking) engine.setDucking(this.state.duckingPercentage);
    this.updateRoot((r) => M.updateNodeInTree(r, id, (n) => ({ ...n, waveformData: blank.slice(), originalWaveformData: blank.slice(), rawAudioData: null })), { silent: true });
  }

  async stopRecording(id = this.state.recordingClockId) {
    if (!this.state.isRecording) return;
    const pcm = await this.recorder.stop();
    engine.setDucking(1);
    this.set({ isRecording: false, recordingClockId: null });
    const duration = Math.max(10, Math.floor((pcm.length / SAMPLE_RATE) * 1000));
    const { waveform } = await dsp("clockWave", { pcm });
    this.updateRoot((r) => M.updateRecursiveCounts(M.updateNodeInTree(r, id, (n) => ({
      ...n, rawAudioData: pcm, originalRawAudioData: pcm, durationMs: duration,
      waveformData: waveform, originalWaveformData: waveform.slice(),
      editTrimStart: 0, editTrimEnd: 1, editDelayMs: 0, editSpeed: 1, editEqBands: [1, 1, 1, 1, 1],
    }))));
  }
}

/** Port processTriggers — zwraca zaktualizowany węzeł lub null, gdy nic się nie zmieniło. */
function processTriggers(node, lastGlobal, currGlobal, isRoot, audio, parentChildrenVolume, mutedDepths, depth) {
  let localLast, localCurr;
  const dur = Math.max(1, node.durationMs);
  if (isRoot) {
    localLast = lastGlobal % dur;
    localCurr = currGlobal % dur;
  } else {
    const trig = node.lastTriggeredTimeMs;
    if (trig == null) return null;
    const eLast = lastGlobal - trig;
    if (eLast >= node.durationMs) return null;
    localLast = eLast;
    localCurr = currGlobal - trig;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const triggerTime = Math.floor((child.angleOnParent / 360) * node.durationMs);
    const crossed = localLast < localCurr
      ? triggerTime >= localLast + 1 && triggerTime <= localCurr
      : triggerTime > localLast || triggerTime <= localCurr;
    let updated = child;
    const vol = parentChildrenVolume * M.childModifier(node, child);
    if (crossed || (lastGlobal === 0 && triggerTime === 0)) {
      updated = { ...child, lastTriggeredTimeMs: currGlobal };
      if (!updated.isPaused && !mutedDepths.has(depth + 1)) {
        const pcm = updated.rawAudioData || updated.originalRawAudioData;
        if (pcm) audio.push([updated.id, pcm, (updated.isMuted ? 0 : updated.volumeModifier) * vol]);
      }
      changed = true;
    }
    const deep = processTriggers(updated, lastGlobal, currGlobal, false, audio, vol, mutedDepths, depth + 1);
    if (deep) { changed = true; return deep; }
    return updated;
  });
  return changed ? { ...node, children } : null;
}

export const studio = new StudioStore();
