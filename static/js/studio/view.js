// Port MuzartScreen + ControlPanel (ClockCanvas.kt) — widok Studio.
import { h, clear, clamp, pressable, pickFile } from "../util.js";
import { t, i18n } from "../i18n.js";
import { dialog, vSlider, hSlider, toast, checkbox, textField, confirmDialog, spinnerOverlay } from "../ui/components.js";
import { engine } from "../audio/engine.js";
import { decodeAudioFile } from "../audio/decoder.js";
import { MicDeniedError, MicUnavailableError } from "../audio/recorder.js";
import { studio } from "./store.js";
import { getMaxDepth } from "./model.js";
import { drawClockTree, findClickedClock, slotAngleAt } from "./canvas.js";
import { openSampleEditor } from "./sample-editor.js";
import { openSettings } from "../settings.js";

let root, canvas, ctx, panelHost, topBar, playBtn;
let view = { scale: 1, x: 0, y: 0 };
let dirty = true;
let panel = null; // { id, el, update(node) }
let sampleEditor = null;

export function mountStudio(container) {
  root = container;
  clear(root);
  root.classList.add("studio");

  canvas = h("canvas.studio-canvas", { "data-tut": "0", "aria-label": "Clock canvas" });
  ctx = canvas.getContext("2d");

  playBtn = h("button.fab-btn", { type: "button", title: "Play / Stop", onclick: () => { studio.togglePlayback(); updateTopBar(); } }, "▶");
  topBar = h("div.studio-top", null,
    h("div.studio-top-left", null,
      h("button.icon-btn", { type: "button", title: t("library"), onclick: openLibrary }, "📚"),
      h("button.icon-btn", { type: "button", title: t("new_project"), onclick: openNewProjectConfirm }, "🆕")),
    h("div.studio-top-center", null,
      h("button.fab-btn", { type: "button", title: "Show all", onclick: () => studio.showAllClocks() }, "👁"),
      playBtn),
    h("div.studio-top-right", null,
      h("button.icon-btn", { type: "button", title: t("settings"), "data-tut": "3", onclick: () => openSettings() }, "⚙️")));

  panelHost = h("div.panel-host");
  root.append(canvas, topBar, panelHost);

  setupGestures();
  new ResizeObserver(() => { resizeCanvas(); }).observe(root);
  resizeCanvas();

  studio.on("change", (patch) => {
    dirty = true;
    if ("selectedClockId" in patch || "rootClock" in patch || "isRecording" in patch || "duplicateSourceId" in patch || "duplicateIncludeChildren" in patch) syncPanel();
    if ("isEnginePlaying" in patch) updateTopBar();
    if ("showSampleEditor" in patch) syncSampleEditor();
  });
  studio.on("tick", () => { dirty = true; });
  i18n.on("change", () => { panel?.el.remove(); panel = null; syncPanel(); });

  window.addEventListener("keydown", onKey);
  requestAnimationFrame(frame);
  syncPanel();
  updateTopBar();
}

function onKey(e) {
  if (root.hidden || e.target.closest("input,textarea,[contenteditable]") || document.querySelector(".dlg-backdrop")) return;
  if (e.code === "Space") { e.preventDefault(); studio.togglePlayback(); }
  else if (e.key === "Escape") { studio.selectClock(null); studio.cancelDuplicateMode(); }
  else if (e.key === "Delete" && studio.s.selectedClockId) { /* celowo bez skrótu usuwania — wymaga potwierdzenia w panelu */ }
}

function updateTopBar() {
  playBtn.textContent = studio.s.isEnginePlaying ? "⏹" : "▶";
}

function resizeCanvas() {
  const r = root.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  dirty = true;
}

function geometry() {
  const w = canvas.clientWidth, hh = canvas.clientHeight;
  return { cx: w / 2, cy: hh / 2, radius: Math.min(w, hh) * 0.35 };
}

function toCanvas(px, py) { return [(px - view.x) / view.scale, (py - view.y) / view.scale]; }

function frame() {
  const s = studio.s;
  if (!root.hidden && (dirty || s.isEnginePlaying || s.isRecording)) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(frame);
}

function draw() {
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
  const { cx, cy, radius } = geometry();
  const s = studio.s;
  const [x0, y0] = toCanvas(0, 0);
  const [x1, y1] = toCanvas(canvas.clientWidth, canvas.clientHeight);
  if (s.rootClock.isVisible) {
    drawClockTree(ctx, s.rootClock, cx, cy, radius, 0, 1, {
      globalTimeMs: s.globalTimeMs,
      selectedClockId: s.selectedClockId,
      duplicateTargetId: s.duplicateTargetId,
      isEnginePlaying: s.isEnginePlaying,
      scale: view.scale,
      viewport: { x0, y0, x1, y1 },
    });
  }
}

// ---------------------------------------------------------------- Gesty

function setupGestures() {
  const pointers = new Map();
  let mode = null; // 'tap' | 'pan' | 'volume' | 'pinch'
  let start = null;
  let volumeHit = null;
  let currentVol = 1;
  let pinch = null;

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // blokuje emulowane zdarzenia myszy (klik "przebijający" do nowo otwartego panelu)
    canvas.setPointerCapture(e.pointerId);
    document.activeElement?.blur?.();
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 1) {
      start = { x: e.offsetX, y: e.offsetY, t: performance.now(), vx: view.x, vy: view.y };
      mode = "tap";
      const { cx, cy, radius } = geometry();
      const [px, py] = toCanvas(e.offsetX, e.offsetY);
      const hit = findClickedClock(studio.s.rootClock, cx, cy, radius, px, py);
      volumeHit = hit && hit.isCenter ? hit : null;
      currentVol = volumeHit ? (studio.getNodeById(volumeHit.id)?.volumeModifier ?? 1) : 1;
    } else if (pointers.size === 2) {
      mode = "pinch";
      pinch = pinchState(pointers);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (mode === "pinch" && pointers.size >= 2) {
      const now = pinchState(pointers);
      const zoom = now.dist / Math.max(1, pinch.dist);
      zoomAt(now.cx, now.cy, zoom, now.cx - pinch.cx, now.cy - pinch.cy);
      pinch = now;
      return;
    }
    if (!start) return;
    const dx = e.offsetX - start.x, dy = e.offsetY - start.y;
    if (mode === "tap" && Math.hypot(dx, dy) > 6) mode = volumeHit ? "volume" : "pan";
    if (mode === "volume") {
      currentVol = clamp(currentVol - (e.offsetY - prev.y) / 150, 0, 2);
      studio.setVolume(volumeHit.id, currentVol);
    } else if (mode === "pan") {
      view.x = start.vx + dx;
      view.y = start.vy + dy;
      dirty = true;
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (mode === "tap" && start && e.type === "pointerup" && performance.now() - start.t < 600) onTap(start.x, start.y);
    if (pointers.size === 1 && mode === "pinch") {
      const [p] = pointers.values();
      start = { x: p.x, y: p.y, t: 0, vx: view.x, vy: view.y };
      mode = "pan";
    } else if (pointers.size === 0) { mode = null; start = null; volumeHit = null; }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || Math.abs(e.deltaX) < 1) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(e.offsetX, e.offsetY, factor, 0, 0);
    } else {
      view.x -= e.deltaX; view.y -= e.deltaY; dirty = true;
    }
  }, { passive: false });

  canvas.addEventListener("dblclick", (e) => e.preventDefault());
}

function pinchState(pointers) {
  const [a, b] = [...pointers.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
}

function zoomAt(px, py, zoom, panX, panY) {
  const maxScale = Math.max(10, Math.pow(4.5, getMaxDepth(studio.s.rootClock)));
  const old = view.scale;
  const ns = clamp(old * zoom, 0.1, maxScale);
  const cx = (px - view.x) / old, cy = (py - view.y) / old;
  view.scale = ns;
  view.x = px - cx * ns + panX;
  view.y = py - cy * ns + panY;
  dirty = true;
}

function onTap(px, py) {
  const s = studio.s;
  const { cx, cy, radius } = geometry();
  const [x, y] = toCanvas(px, py);
  const hit = findClickedClock(s.rootClock, cx, cy, radius, x, y);
  if (!hit) { studio.selectClock(null); studio.cancelDuplicateMode(); return; }

  if (s.duplicateSourceId) {
    if (hit.isCenter) studio.setDuplicateTarget(hit.id);
    else if (hit.id === s.duplicateTargetId) {
      const node = studio.getNodeById(hit.id);
      if (node && node.segments > 1) studio.duplicateNodeIntoSlot(s.duplicateSourceId, hit.id, slotAngleAt(node, hit, x, y));
    }
    return;
  }
  if (hit.isCenter) studio.selectClock(hit.id);
  else if (hit.id === s.selectedClockId) {
    const node = studio.getNodeById(s.selectedClockId);
    if (node && node.segments > 1) {
      const angle = slotAngleAt(node, hit, x, y);
      if (!node.children.some((c) => Math.abs(c.angleOnParent - angle) < 1)) studio.addSubClock(node.id, angle, 10);
    }
  } else studio.selectClock(hit.id);
}

// ---------------------------------------------------------------- Panel sterowania

function syncPanel() {
  const s = studio.s;
  const node = s.selectedClockId ? studio.getNodeById(s.selectedClockId) : null;
  if (!node) {
    if (panel) { panel.el.remove(); panel = null; }
    return;
  }
  if (!panel || panel.id !== node.id) {
    panel?.el.remove();
    panel = buildPanel(node);
    panelHost.appendChild(panel.el);
  }
  panel.update(node);
}

function buildPanel(initial) {
  const id = initial.id;
  let deleteConfirm = false;
  let showDuplicateOptions = false;
  let showFilter = false;
  let editingName = false;

  // --- Filtr dzieci (presety + przełączniki) ---
  const presetRow = h("div.preset-row");
  const childrenRow = h("div.children-row");
  const filterBox = h("div.filter-box", { hidden: true }, presetRow, childrenRow);

  // --- Nagłówek ---
  const editBtn = h("button.btn.text.small.edit-btn", { type: "button", "data-tut": "2", onclick: () => studio.setShowSampleEditor(true) }, `${t("edit")} ✂️`);
  const title = h("button.panel-title", { type: "button", onclick: () => { editingName = true; renderHeader(); } });
  const emojiInput = h("input.input.emoji-input", { type: "text", maxlength: "8", "aria-label": t("emoji") });
  const nameInput = h("input.input", { type: "text", "aria-label": t("name") });
  const commitMeta = () => { studio.updateClockMeta(id, nameInput.value, emojiInput.value); };
  const finishEdit = () => { commitMeta(); editingName = false; renderHeader(); };
  [emojiInput, nameInput].forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finishEdit(); if (e.key === "Escape") { editingName = false; renderHeader(); } });
    inp.addEventListener("blur", () => setTimeout(() => {
      if (editingName && document.activeElement !== emojiInput && document.activeElement !== nameInput) finishEdit();
    }, 0));
  });
  const headerView = h("div.panel-header", null, editBtn, title);
  const headerEdit = h("div.panel-header-edit", null, emojiInput, nameInput, h("button.btn.primary.small", { type: "button", onclick: finishEdit }, "✔"));
  const header = h("div", null, headerView, headerEdit);
  function renderHeader() {
    const n = studio.getNodeById(id);
    headerView.hidden = editingName;
    headerEdit.hidden = !editingName;
    if (editingName && n) {
      if (document.activeElement !== emojiInput) emojiInput.value = n.emoji;
      if (document.activeElement !== nameInput) nameInput.value = n.name;
      if (!headerEdit.contains(document.activeElement)) nameInput.focus();
    }
  }

  // --- Siatka ---
  const gridBadge = h("span.badge");
  const gridSlider = hSlider({ value: initial.segments, min: 1, max: 24, step: 1, onInput: (v) => { gridBadge.textContent = `${v} ${t("grid")}`; studio.splitClock(id, v); } });

  // --- Przyciski ---
  const btn = (label, cls, onClick) => h(`button.pbtn.${cls}`, { type: "button", onclick: onClick }, label);
  const playB = btn(t("play"), "blue", () => { engine.unlock(); studio.playClock(id); });
  const pauseB = btn(t("pause"), "blue", () => studio.togglePause(id));
  const playAllB = btn(t("play_all"), "blue", () => { engine.unlock(); studio.playClockAll(id); });
  const pauseAllB = btn(t("pause_all"), "blue", () => studio.togglePauseAll(id));
  const dupB = btn(t("duplicate"), "purple", () => { showDuplicateOptions = true; update(studio.getNodeById(id)); });
  const oneB = btn(t("one"), "purple", () => studio.toggleDuplicateMode(id, false));
  const allB = btn(t("all"), "purple", () => studio.toggleDuplicateMode(id, true));
  const dupWrap = h("div.pbtn-split", null, oneB, allB);
  const hideB = btn(`🙈 ${t("hide")}`, "orange", () => studio.hideClock(id));
  const delB = h("button.pbtn.square.red", { type: "button", title: t("delete"), onclick: () => {
    if (deleteConfirm) studio.deleteClock(id);
    else { deleteConfirm = true; update(studio.getNodeById(id)); }
  } }, "🗑");
  const saveB = h("button.pbtn.square.green", { type: "button", title: t("save_to_library"), onclick: () => openSaveToLibrary(studio.getNodeById(id)) }, "💾");
  const importB = h("button.pbtn.square.green", { type: "button", title: t("import_audio"), onclick: () => importIntoClock(id) }, "📂");
  const recB = h("button.pbtn.rec", { type: "button", onclick: () => toggleRecording(id) });

  const buttons = h("div.panel-buttons", null,
    h("div.prow", null, playB, pauseB),
    h("div.prow", null, playAllB, pauseAllB),
    h("div.prow", null, dupB, dupWrap, hideB),
    h("div.prow", null, delB, saveB, importB, recB));

  // --- Suwaki głośności ---
  const muteB = h("button.mute-btn", { type: "button", onclick: () => studio.toggleMute(id) });
  const volS = vSlider({ value: initial.volumeModifier, min: 0, max: 2, label: t("clock"), onInput: (v) => studio.setVolume(id, v) });
  const cMuteB = h("button.mute-btn", { type: "button", onclick: () => studio.toggleChildrenMute(id) });
  const cVolS = vSlider({ value: initial.childrenVolumeModifier, min: 0, max: 2, label: t("children"), onInput: (v) => studio.setChildrenVolume(id, v) });
  const filterB = h("button.filter-toggle", { type: "button", onclick: () => { showFilter = !showFilter; update(studio.getNodeById(id)); } });
  const volumes = h("div.panel-volumes", null,
    h("div.vol-col", null, h("div.vol-spacer"), h("div.vol-label", null, t("clock")), muteB, volS),
    h("div.vol-col", null, filterB, h("div.vol-label", null, t("children")), cMuteB, cVolS));

  const el = h("div.control-panel", { "data-tut": "1" },
    filterBox,
    h("div.panel-main", null,
      header,
      h("div.grid-row", null, gridBadge, gridSlider),
      h("div.panel-bottom", null, buttons, volumes)));

  function update(n) {
    if (!n) return;
    const s = studio.s;
    title.textContent = `${n.emoji || "⏱"} ${n.name || t("clock")}`;
    renderHeader();
    if (document.activeElement !== gridSlider) gridSlider.setValue(n.segments);
    gridBadge.textContent = `${n.segments} ${t("grid")}`;
    pauseB.classList.toggle("active", n.isPaused);
    pauseAllB.classList.toggle("active", n.isPaused);
    const dupActive = s.duplicateSourceId === id;
    const showSplit = showDuplicateOptions || dupActive;
    dupB.hidden = showSplit;
    dupWrap.hidden = !showSplit;
    oneB.classList.toggle("active", dupActive && !s.duplicateIncludeChildren);
    allB.classList.toggle("active", dupActive && s.duplicateIncludeChildren);
    delB.textContent = deleteConfirm ? "❓" : "🗑";
    const recordingHere = s.isRecording;
    recB.textContent = recordingHere ? `⬛ ${t("stop")}` : `🔴 ${t("rec")}`;
    recB.classList.toggle("recording", recordingHere);
    muteB.textContent = n.isMuted || n.volumeModifier === 0 ? "🔇" : "🔊";
    cMuteB.textContent = n.isChildrenMuted || n.childrenVolumeModifier === 0 ? "🔇" : "🔊";
    if (!volS.classList.contains("active")) volS.setValue(n.volumeModifier);
    if (!cVolS.classList.contains("active")) cVolS.setValue(n.childrenVolumeModifier);
    filterB.textContent = `${showFilter ? "▲" : "▼"} ${t("filter")}`;
    filterBox.hidden = !showFilter;
    if (showFilter) renderFilter(n);
  }

  function renderFilter(n) {
    clear(presetRow);
    for (let i = 0; i < 4; i++) presetRow.appendChild(presetSlot(n, i));
    clear(childrenRow);
    if (!n.children.length) childrenRow.appendChild(h("div.muted.small", null, t("no_subclocks_filter")));
    for (const c of n.children) {
      const excluded = n.volumeExcludedChildren.includes(c.id);
      childrenRow.appendChild(h(`button.child-chip${excluded ? ".excluded" : ""}`, {
        type: "button", title: c.name || t("clock"),
        onclick: () => studio.toggleChildVolumeExclusion(id, c.id),
      }, c.emoji || "⏱"));
    }
  }

  function presetSlot(n, i) {
    const preset = n.volumePresets[i];
    const b = h(`button.preset${preset ? ".filled" : ""}`, { type: "button" }, preset?.name || `SAVE ${i + 1}`);
    pressable(b, {
      onClick: () => (preset ? studio.loadVolumePreset(id, i) : studio.saveVolumePreset(id, i)),
      onLong: () => { if (preset) editPreset(n, i, preset); },
    });
    return b;
  }

  function editPreset(n, i, preset) {
    const f = textField(t("name"), preset.name, { autofocus: true });
    dialog({
      title: preset.name,
      content: f.el,
      actions: [
        { label: t("delete"), variant: "danger", onClick: () => studio.deleteVolumePreset(id, i) },
        { label: t("cancel"), variant: "text" },
        { label: t("save"), variant: "primary", onClick: () => studio.renameVolumePreset(id, i, f.input.value || preset.name) },
      ],
    });
  }

  return { id, el, update };
}

async function toggleRecording(id) {
  if (studio.s.isRecording) { await studio.stopRecording(); return; }
  try {
    await engine.unlock();
    await studio.startRecordingToClock(id);
  } catch (e) {
    if (e instanceof MicDeniedError) toast(t("mic_denied"));
    else if (e instanceof MicUnavailableError) toast(t("mic_unavailable"));
    else toast(String(e?.message || e));
  }
}

async function importIntoClock(id) {
  const file = await pickFile("audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac");
  if (!file) return;
  const busy = spinnerOverlay(t("processing_track"));
  root.appendChild(busy);
  try {
    const { pcm } = await decodeAudioFile(file);
    studio.importAudioToClock(id, pcm, file.name.replace(/\.[^.]+$/, ""));
  } catch (e) {
    console.error(e);
    toast(t("audio_import_failed"));
  } finally { busy.remove(); }
}

function syncSampleEditor() {
  const s = studio.s;
  if (s.showSampleEditor && !sampleEditor) {
    const node = studio.getNodeById(s.selectedClockId);
    if (!node) { studio.setShowSampleEditor(false); return; }
    sampleEditor = openSampleEditor(node, { onClose: () => { sampleEditor = null; if (studio.s.showSampleEditor) studio.setShowSampleEditor(false); } });
  } else if (!s.showSampleEditor && sampleEditor) {
    const d = sampleEditor; sampleEditor = null; d.close();
  }
}

// ---------------------------------------------------------------- Dialogi

function openSaveToLibrary(node) {
  if (!node) return;
  let includeChildren = true;
  const emoji = textField(t("emoji"), node.emoji || "🥁");
  const name = textField(t("name"), node.name || "Mój Zegar", { autofocus: true });
  dialog({
    title: t("save_to_library"),
    content: [emoji.el, name.el, checkbox(t("save_with_children"), true, (v) => { includeChildren = v; })],
    actions: [
      { label: t("cancel"), variant: "text" },
      {
        label: t("save"), variant: "primary",
        onClick: () => { studio.saveClockToLibrary(node, name.input.value, emoji.input.value, includeChildren).then(() => toast(t("saved_to_library"))); },
      },
    ],
  });
}

function openLibrary() {
  let tab = 0;
  const tabs = h("div.tabs");
  const list = h("div.lib-list");
  const d = dialog({ title: t("library"), size: "md", content: [tabs, list], actions: [{ label: t("close"), variant: "primary" }] });
  const unsub = studio.on("change", (p) => { if ("library" in p || "savedPlaylists" in p) render(); });
  const origClose = d.close;
  d.close = () => { unsub(); origClose(); };

  function render() {
    clear(tabs);
    [t("samples"), t("playlists")].forEach((label, i) => tabs.appendChild(h(`button.tab-btn${tab === i ? ".active" : ""}`, { type: "button", onclick: () => { tab = i; render(); } }, label)));
    clear(list);
    const s = studio.s;
    if (tab === 0) {
      if (!s.library.length) list.appendChild(h("p.muted", null, t("library_empty")));
      for (const n of s.library) {
        list.appendChild(h("div.lib-card", null,
          h("div.lib-info", null, h("div.lib-name", null, `${n.emoji} ${n.name}`), h("div.lib-sub", null, `${t("subclocks")}: ${n.recursiveChildrenCount}`)),
          h("div.lib-actions", null,
            h("button.icon-btn.danger", { type: "button", title: t("delete"), onclick: async () => {
              if (await confirmDialog({ title: t("delete"), message: t("delete_confirm"), confirmLabel: t("delete"), danger: true })) studio.removeFromLibrary(n.id);
            } }, "🗑"),
            s.selectedClockId ? h("button.btn.success.small", { type: "button", onclick: () => { studio.loadClockFromLibrary(s.selectedClockId, n); d.close(); } }, t("load")) : null)));
      }
    } else {
      if (!s.savedPlaylists.length) list.appendChild(h("p.muted", null, t("no_saved_playlists")));
      for (const p of s.savedPlaylists) {
        list.appendChild(h("div.lib-card", null,
          h("div.lib-info", null, h("div.lib-name", null, p.name), h("div.lib-sub", null, `${t("scenes")}: ${p.scenes.length}`)),
          h("div.lib-actions", null,
            h("button.icon-btn.danger", { type: "button", title: t("delete"), onclick: async () => {
              if (await confirmDialog({ title: t("delete"), message: t("delete_confirm"), confirmLabel: t("delete"), danger: true })) studio.removePlaylistFromLibrary(p.id);
            } }, "🗑"),
            h("button.btn.success.small", { type: "button", onclick: () => { studio.loadPlaylistFromLibrary(p); d.close(); } }, t("load")))));
      }
    }
  }
  render();
}

function openNewProjectConfirm() {
  dialog({
    title: t("new_project"),
    content: h("p", null, t("save_before_new")),
    actions: [
      { label: t("new_without_save"), variant: "danger-text", onClick: () => studio.newProject() },
      { label: t("save_and_new"), variant: "primary", onClick: () => openSaveBeforeNew() },
    ],
  });
}

function openSaveBeforeNew() {
  const f = textField(t("playlist_name"), "", { autofocus: true });
  const d = dialog({
    title: t("save_playlist"),
    content: f.el,
    actions: [
      { label: t("cancel"), variant: "text" },
      {
        label: t("save"), variant: "primary",
        onClick: () => {
          if (!f.input.value.trim()) { f.input.focus(); return false; }
          studio.savePlaylistToLibrary(f.input.value.trim()).then(() => { toast(t("playlist_saved")); studio.newProject(); });
        },
      },
    ],
  });
  f.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && f.input.value.trim()) { studio.savePlaylistToLibrary(f.input.value.trim()).then(() => studio.newProject()); d.close(); } });
}

export function studioRedraw() { dirty = true; resizeCanvas(); }
