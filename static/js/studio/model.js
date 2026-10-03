// Port ClockNode.kt / Scene.kt + operacje na drzewie zegarów.
import { uuid } from "../util.js";

export function createClock(props = {}) {
  return {
    id: uuid(),
    durationMs: 4000,
    angleOnParent: 0,
    radiusRatio: 1.1,
    segments: 1,
    children: [],
    lastTriggeredTimeMs: null,
    waveformData: null,
    originalWaveformData: null,
    volumeModifier: 1,
    isMuted: false,
    previousVolume: 1,
    childrenVolumeModifier: 1,
    isChildrenMuted: false,
    previousChildrenVolume: 1,
    volumeExcludedChildren: [],
    volumePresets: {},
    bassBoost: 1,
    pitchShift: 1,
    rawAudioData: null,
    originalRawAudioData: null,
    editTrimStart: 0,
    editTrimEnd: 1,
    editDelayMs: 0,
    editSpeed: 1,
    editEqBands: [1, 1, 1, 1, 1],
    isPaused: false,
    name: "",
    emoji: "",
    isVisible: true,
    recursiveChildrenCount: 0,
    ...props,
  };
}

/** Uzupełnia brakujące pola (np. dane z biblioteki zapisane starszą wersją). */
export function normalizeClock(n) {
  const base = createClock({ id: n.id || uuid() });
  const out = { ...base, ...n };
  out.children = (n.children || []).map(normalizeClock);
  out.volumeExcludedChildren = Array.from(n.volumeExcludedChildren || []);
  out.editEqBands = Array.from(n.editEqBands || [1, 1, 1, 1, 1]);
  out.volumePresets = { ...(n.volumePresets || {}) };
  return out;
}

export function createScene(name, rootClock, props = {}) {
  return { id: uuid(), name, rootClock, loopCount: 1, masterLowPassFilter: 1, mutedDepths: [], ...props };
}

export function createPlaylist(name, scenes) {
  return { id: uuid(), name, scenes };
}

export function updateNodeInTree(node, targetId, transform) {
  if (node.id === targetId) return transform(node);
  let changed = false;
  const children = node.children.map((c) => {
    const u = updateNodeInTree(c, targetId, transform);
    if (u !== c) changed = true;
    return u;
  });
  return changed ? { ...node, children } : node;
}

export function removeNodeFromTree(node, idToRemove) {
  if (node.id === idToRemove) return null;
  return { ...node, children: node.children.map((c) => removeNodeFromTree(c, idToRemove)).filter(Boolean) };
}

export function getNodeById(node, targetId) {
  if (!targetId || !node) return null;
  if (node.id === targetId) return node;
  for (const c of node.children) {
    const f = getNodeById(c, targetId);
    if (f) return f;
  }
  return null;
}

export function updateRecursiveCounts(node) {
  const children = node.children.map(updateRecursiveCounts);
  const total = children.length + children.reduce((s, c) => s + c.recursiveChildrenCount, 0);
  return { ...node, children, recursiveChildrenCount: total };
}

/** Głęboka kopia z nowymi ID (copyNodeRecursive). Dane PCM są niemutowalne, więc mogą być współdzielone. */
export function copyNodeRecursive(node) {
  // Mapa stare ID -> nowe ID, aby filtry głośności dzieci i presety nadal działały po skopiowaniu.
  const idMap = new Map();
  (function collect(n) { idMap.set(n.id, uuid()); n.children.forEach(collect); })(node);
  const remap = (ids) => ids.map((id) => idMap.get(id) || id);
  function copy(n) {
    const presets = {};
    for (const [k, p] of Object.entries(n.volumePresets || {})) presets[k] = { ...p, excludedIds: remap(p.excludedIds || []) };
    return {
      ...n,
      id: idMap.get(n.id),
      lastTriggeredTimeMs: null,
      isVisible: true,
      children: n.children.map(copy),
      editEqBands: [...n.editEqBands],
      volumeExcludedChildren: remap(n.volumeExcludedChildren),
      volumePresets: presets,
    };
  }
  return copy(node);
}

export function setAllVisibilityRecursive(node, visible) {
  return { ...node, isVisible: visible, children: node.children.map((c) => setAllVisibilityRecursive(c, visible)) };
}

export function clearTriggersRecursive(node) {
  return { ...node, lastTriggeredTimeMs: null, children: node.children.map(clearTriggersRecursive) };
}

export function setPauseRecursive(node, state) {
  return { ...node, isPaused: state, children: node.children.map((c) => setPauseRecursive(c, state)) };
}

export function getMaxDepth(node) {
  if (!node.children.length || !node.isVisible) return 0;
  return 1 + Math.max(...node.children.map(getMaxDepth));
}

export function childModifier(parent, child) {
  if (parent.volumeExcludedChildren.includes(child.id)) return 1;
  return parent.isChildrenMuted ? 0 : parent.childrenVolumeModifier;
}

/** Usuwa dane czasu rzeczywistego przed zapisem. */
export function stripRuntime(node) {
  return { ...node, lastTriggeredTimeMs: null, children: node.children.map(stripRuntime) };
}
