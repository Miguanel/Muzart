// Port ChronosTimeline.kt — widok Aranżera Chronos (oś czasu DAW).
import { h, clear, clamp, pressable } from "../util.js";
import { t, i18n } from "../i18n.js";
import { vSlider, actionButton, dialog as baseDialog, toast, spinnerOverlay } from "../ui/components.js";
import { MicDeniedError, MicUnavailableError } from "../audio/recorder.js";
import { chronos, ToolMode } from "./store.js";
import {
  openAddTrackDialog, openTrackMenu, openLinkMarkerDialog, openAddMarkerDialog,
  openEditMarkerDialog, openClipEditor, openProjectLibrary,
} from "./dialogs.js";

const cdialog = (o) => baseDialog({ ...o, className: `chronos-dialog ${o.className || ""}`.trim() });

const PX_PER_BEAT = 100;
const RULER_H = 28;
let TRACK_H = 60;
let HEADER_W = 100;

let root, projectLabel, transport, headersInner, headersCol, ruler, rulerCtx, main, mainCtx, panelHost, busyEl;
let camX = 0, zoomX = 1, scrollY = 0;
let dirty = true;
let drag = null; // { kind: 'clip'|'playhead'|'marker'|'starter', ... }
let ghost = null; // { clipId, beat, trackId }
let currentPanelKey = null;
let pulseEl = null;

const effP = () => PX_PER_BEAT * zoomX;
const beatToX = (b) => b * effP() + camX;
const xToBeat = (x) => (x - camX) / effP();
const quantize = (b, min = 0) => Math.max(min, Math.round(b / chronos.tl.gridResolution) * chronos.tl.gridResolution);

export function mountChronos(container) {
  root = container;
  clear(root);
  root.classList.add("chronos");
  computeMetrics();

  projectLabel = h("div.proj-label");
  const libBtn = h("button.btn.primary.small", { type: "button", onclick: openProjectLibrary }, `📁 ${t("library_btn")}`);
  const topbar = h("div.chr-topbar", null, projectLabel, libBtn);

  transport = h("div.transport");
  headersInner = h("div.headers-inner");
  headersCol = h("div.headers", null, h("div.headers-corner"), h("div.headers-viewport", null, headersInner));
  ruler = h("canvas.ruler");
  rulerCtx = ruler.getContext("2d");
  main = h("canvas.timeline");
  mainCtx = main.getContext("2d");
  const right = h("div.chr-right", null, ruler, h("div.timeline-wrap", null, main));
  panelHost = h("div.chr-panel-host");
  const body = h("div.chr-body", null, headersCol, right, panelHost);
  root.append(topbar, transport, body);

  renderTransport();
  renderHeaders();
  renderProject();
  setupRuler();
  setupMain();
  setupHeaderScroll();

  new ResizeObserver(() => { computeMetrics(); resize(); renderHeaders(); }).observe(root);
  resize();

  chronos.on("change", (p) => {
    dirty = true;
    if ("tracks" in p || "selectedTrackId" in p) renderHeaders();
    if ("projectName" in p) renderProject();
    if ("timeline" in p || "toolMode" in p) updateTransport();
    if ("selectedClipIds" in p || "selectedTrackId" in p || "clips" in p || "recordingTrackId" in p || "playingClipId" in p || "toolMode" in p || "tracks" in p) syncPanel();
    if ("isImporting" in p) syncBusy();
  });
  i18n.on("change", () => { libBtn.textContent = `📁 ${t("library_btn")}`; renderTransport(); renderProject(); renderHeaders(); currentPanelKey = null; syncPanel(); });
  requestAnimationFrame(frame);
}

function computeMetrics() {
  const narrow = window.innerWidth < 600;
  HEADER_W = narrow ? 92 : 110;
  TRACK_H = narrow ? 56 : 60;
  root?.style.setProperty("--header-w", `${HEADER_W}px`);
  root?.style.setProperty("--track-h", `${TRACK_H}px`);
}

function renderProject() { projectLabel.textContent = `${t("project")}: ${chronos.s.projectName}`; }

// ---------------------------------------------------------------- Transport

let transportRefs = {};
function renderTransport() {
  clear(transport);
  const tb = (text, cls, onClick) => h(`button.tbtn.${cls}`, { type: "button", onclick: onClick }, text);
  const playB = tb("", "green", () => chronos.togglePlayback());
  const restartB = tb(t("transport_restart"), "blue", () => chronos.playFromStartAndReset());
  const tools = [[ToolMode.PAN, "🖐"], [ToolMode.MOVE, "↔"], [ToolMode.MULTI_SELECT, "☑"]].map(([m, icon]) =>
    h("button.tool", { type: "button", title: m, onclick: () => chronos.setToolMode(m), dataset: { mode: m } }, icon));
  const gridBtns = [[1, "1/1"], [0.5, "1/2"], [0.25, "1/4"], [0.125, "1/8"]].map(([v, l]) =>
    h("button.grid-btn", { type: "button", onclick: () => chronos.setGridResolution(v), dataset: { v } }, l));
  pulseEl = h("span.pulse");
  const metro = h("button.metro", { type: "button", onclick: () => chronos.toggleMetronome() },
    h("span.metro-label", null, t("chronometer")),
    h("span.metro-icon", null, pulseEl, h("span.metro-glyph", null, "⏱")));
  const master = vSlider({ value: chronos.tl.masterVolume, min: 0, max: 1, label: "MASTER", onInput: (v) => chronos.setMasterVolume(v), className: "small" });
  const back = vSlider({ value: chronos.tl.secondaryVolume, min: 0, max: 1, label: "BACK", onInput: (v) => chronos.setSecondaryVolume(v), className: "small" });

  transport.append(
    h("div.tgroup", null, playB, restartB),
    h("div.tsep"),
    h("div.tgroup", null, ...tools),
    h("div.tsep"),
    h("div.tgrid", null, h("div.tlabel", null, t("grid_upper")), h("div.tgroup.tight", null, ...gridBtns)),
    h("div.tsep"),
    metro,
    h("div.tspacer"),
    h("div.tvol", null, h("div.tlabel", null, "MASTER"), master),
    h("div.tvol", null, h("div.tlabel", null, "BACK"), back));
  transportRefs = { playB, tools, gridBtns, metro, master, back };
  updateTransport();
}

function updateTransport() {
  const tl = chronos.tl;
  const { playB, tools, gridBtns, metro } = transportRefs;
  if (!playB) return;
  playB.textContent = tl.isPlaying ? t("transport_pause") : t("transport_play");
  playB.classList.toggle("yellow", tl.isPlaying);
  playB.classList.toggle("green", !tl.isPlaying);
  tools.forEach((b) => b.classList.toggle("active", b.dataset.mode === chronos.s.toolMode));
  gridBtns.forEach((b) => b.classList.toggle("active", +b.dataset.v === tl.gridResolution));
  metro.classList.toggle("on", tl.isMetronomeEnabled);
  main && (main.dataset.tool = chronos.s.toolMode);
}

// ---------------------------------------------------------------- Nagłówki korytarzy

function renderHeaders() {
  clear(headersInner);
  for (const tr of chronos.s.tracks) {
    const focused = chronos.s.selectedTrackId === tr.id;
    const el = h(`div.track-header${focused ? ".focused" : ""}`, { role: "button", tabindex: "0", title: tr.name }, h("span", null, tr.name),
      h("button.track-menu", { type: "button", "aria-label": "menu", onclick: (e) => { e.stopPropagation(); openTrackMenu(tr); } }, "⋯"));
    pressable(el, {
      onClick: (e) => { if (e.target.closest(".track-menu")) return; chronos.selectTrack(focused ? null : tr.id); chronos.selectClip(null); },
      onLong: () => openTrackMenu(tr),
    });
    headersInner.appendChild(el);
  }
  headersInner.appendChild(h("button.track-add", { type: "button", title: t("new_track"), onclick: openAddTrackDialog }, "+"));
  applyScroll();
}

function maxScroll() {
  const viewH = main?.clientHeight || 0;
  return Math.max(0, (chronos.s.tracks.length + 1) * TRACK_H - viewH);
}

function applyScroll() {
  scrollY = clamp(scrollY, 0, maxScroll());
  headersInner.style.transform = `translateY(${-scrollY}px)`;
  dirty = true;
}

function setupHeaderScroll() {
  const vp = headersCol.querySelector(".headers-viewport");
  vp.addEventListener("wheel", (e) => { e.preventDefault(); scrollY += e.deltaY; applyScroll(); }, { passive: false });
  let start = null;
  vp.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") start = { y: e.clientY, s: scrollY, moved: false }; });
  vp.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    if (Math.abs(dy) > 6) start.moved = true;
    if (start.moved) { scrollY = start.s - dy; applyScroll(); }
  });
  const end = () => { if (start?.moved) { const block = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; vp.addEventListener("click", block, { capture: true, once: true }); setTimeout(() => vp.removeEventListener("click", block, { capture: true }), 50); } start = null; };
  vp.addEventListener("pointerup", end);
  vp.addEventListener("pointercancel", () => { start = null; });
}

// ---------------------------------------------------------------- Rozmiar / rysowanie

function resize() {
  for (const c of [ruler, main]) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }
  applyScroll();
  dirty = true;
}

function frame() {
  if (!root.hidden) {
    const tl = chronos.tl;
    if (dirty || tl.isPlaying || drag) {
      dirty = false;
      drawRuler();
      drawMain();
    }
    if (pulseEl) {
      if (tl.isMetronomeEnabled) {
        const fr = tl.currentPlayheadBeat % 1;
        const a = Math.max(0, Math.min(1, 1 - fr));
        pulseEl.style.opacity = a;
        pulseEl.style.transform = `scale(${1 + 0.8 * a})`;
      } else pulseEl.style.opacity = 0;
    }
  }
  requestAnimationFrame(frame);
}

function prep(canvas, ctx) {
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [canvas.clientWidth, canvas.clientHeight];
}

function drawRuler() {
  const [w, hh] = prep(ruler, rulerCtx);
  const c = rulerCtx;
  const tl = chronos.tl;
  c.fillStyle = "#1B2631";
  c.fillRect(0, 0, w, hh);
  if (w <= 0) return;
  const ep = effP();
  const g = Math.max(0.125, tl.gridResolution);
  const startI = Math.max(0, Math.floor((-camX / ep) / g));
  const endI = Math.ceil(((w - camX) / ep) / g);
  const showSub = g * ep >= 4;
  c.font = "10px system-ui, sans-serif";
  c.textAlign = "left";
  const labelEvery = ep < 30 ? Math.ceil(30 / ep) : 1;
  for (let i = startI; i <= endI; i++) {
    const beat = i * g;
    const x = beat * ep + camX;
    const whole = Math.abs(beat % 1) < 1e-9;
    if (!whole && !showSub) continue;
    c.strokeStyle = whole ? "#fff" : "rgba(255,255,255,0.3)";
    c.lineWidth = whole ? 2 : 1;
    c.beginPath(); c.moveTo(x, hh - (whole ? 12 : 6)); c.lineTo(x, hh); c.stroke();
    if (whole && Math.round(beat) % labelEvery === 0 && x >= -50 && x <= w + 50) {
      c.fillStyle = "rgba(255,255,255,0.7)";
      c.fillText(`${(beat * (60 / tl.bpm)).toFixed(1)}s`, x + 4, 11);
    }
  }
  // Startery — zielone strzałki w górę
  for (const m of tl.starterMarkers) {
    const x = beatToX(m.beat);
    if (x < -50 || x > w + 50) continue;
    c.fillStyle = "#10B981";
    c.beginPath(); c.moveTo(x - 14, hh); c.lineTo(x + 14, hh); c.lineTo(x, hh - 18); c.closePath(); c.fill();
    c.fillStyle = "#fff"; c.font = "bold 9px system-ui"; c.textAlign = "center";
    c.fillText(m.maxLoops === -1 ? "∞" : String(m.maxLoops - m.currentLoops), x, hh - 3);
    c.textAlign = "left";
  }
  // Breakery — niebieskie strzałki w dół
  for (const m of tl.loopMarkers) {
    const x = beatToX(m.beat);
    if (x < -50 || x > w + 50) continue;
    c.fillStyle = "#3B82F6";
    c.beginPath(); c.moveTo(x - 14, 0); c.lineTo(x + 14, 0); c.lineTo(x, 22); c.closePath(); c.fill();
    c.fillStyle = "#fff"; c.font = "bold 10px system-ui"; c.textAlign = "center";
    c.fillText(m.maxLoops === -1 ? "∞" : String(m.maxLoops - m.currentLoops), x, 11);
    c.textAlign = "left";
    c.strokeStyle = "#3B82F6"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, hh); c.stroke();
  }
  // Głowica odtwarzania
  const px = beatToX(tl.currentPlayheadBeat);
  if (px >= 0 && px <= w) {
    c.fillStyle = "#EF4444";
    c.beginPath(); c.moveTo(px - 10, 0); c.lineTo(px + 10, 0); c.lineTo(px, hh); c.closePath(); c.fill();
  }
}

function roundRect(c, x, y, w, hh, r) {
  r = Math.min(r, Math.abs(w) / 2, hh / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + hh, r);
  c.arcTo(x + w, y + hh, x, y + hh, r);
  c.arcTo(x, y + hh, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawMain() {
  const [w, hh] = prep(main, mainCtx);
  const c = mainCtx;
  const s = chronos.s;
  const tl = s.timeline;
  const ep = effP();
  c.clearRect(0, 0, w, hh);
  c.save();
  c.translate(0, -scrollY);
  const totalH = s.tracks.length * TRACK_H;

  // Siatka
  const g = Math.max(0.125, tl.gridResolution);
  const startI = Math.max(0, Math.floor((-camX / ep) / g));
  const endI = Math.ceil(((w - camX) / ep) / g);
  const showSub = g * ep >= 4;
  for (let i = startI; i <= endI; i++) {
    const beat = i * g;
    const whole = Math.abs(beat % 1) < 1e-9;
    if (!whole && !showSub) continue;
    const x = beat * ep + camX;
    c.strokeStyle = whole ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.05)";
    c.lineWidth = whole ? 2 : 1;
    c.beginPath(); c.moveTo(x, scrollY); c.lineTo(x, scrollY + hh); c.stroke();
  }

  const trackIndex = new Map(s.tracks.map((tr, i) => [tr.id, i]));

  // Obłok możliwych korytarzy w trybie MOVE
  if (s.toolMode === ToolMode.MOVE && s.selectedClipIds.size) {
    const first = s.clips.find((cl) => s.selectedClipIds.has(cl.id));
    const idx = first ? trackIndex.get(first.trackId) : undefined;
    if (idx != null) {
      const a = Math.max(0, idx - 1), b = Math.min(s.tracks.length - 1, idx + 1);
      c.fillStyle = "rgba(255,255,255,0.04)";
      c.fillRect(0, a * TRACK_H, w, (b - a + 1) * TRACK_H);
    }
  }

  const pad = 4;
  const viewTop = scrollY - TRACK_H, viewBottom = scrollY + hh + TRACK_H;
  for (const clip of s.clips) {
    const idx = trackIndex.get(clip.trackId);
    if (idx == null) continue;
    const y = idx * TRACK_H + pad;
    if (y < viewTop || y > viewBottom) continue;
    const x = clip.startBeat * ep + camX;
    const cw = clip.durationBeats * ep;
    if (x > w || x + cw < 0) continue;
    const ch = TRACK_H - pad * 2;
    const sel = s.selectedClipIds.has(clip.id);
    const muted = clip.isMuted;
    const alpha = ghost?.clipId === clip.id ? 0.3 : muted ? 0.3 : 1;
    c.globalAlpha = alpha;
    c.fillStyle = sel ? "#6366F1" : muted ? "#334155" : "#475569";
    roundRect(c, x, y, cw, ch, 6); c.fill();
    c.globalAlpha = 1;
    if (sel && s.toolMode === ToolMode.MOVE && ghost?.clipId !== clip.id) {
      c.strokeStyle = muted ? "rgba(255,255,255,0.5)" : "#fff"; c.lineWidth = 3;
      roundRect(c, x, y, cw, ch, 6); c.stroke();
      c.strokeStyle = muted ? "rgba(59,130,246,0.3)" : "rgba(59,130,246,0.6)"; c.lineWidth = 5;
      roundRect(c, x - 2, y - 2, cw + 4, ch + 4, 8); c.stroke();
    }
    const wf = clip.activeEqProfile === "B" ? clip.altWaveformData : clip.waveformData;
    if (wf?.length) {
      const bw = cw / wf.length;
      const mid = y + ch / 2;
      const col = clip.activeEqProfile === "B" ? "239,68,68" : "255,255,255";
      c.strokeStyle = `rgba(${col},${(muted ? 0.2 : 0.7) * alpha})`;
      c.lineWidth = Math.max(1, Math.min(2, bw));
      c.beginPath();
      const from = Math.max(0, Math.floor(-x / bw)), to = Math.min(wf.length, Math.ceil((w - x) / bw) + 1);
      for (let i = from; i < to; i++) {
        const bh = wf[i] * ch * 0.7;
        const xx = x + i * bw;
        c.moveTo(xx, mid - bh / 2); c.lineTo(xx, mid + bh / 2);
      }
      c.stroke();
    }
    if (cw > 40) {
      c.fillStyle = "rgba(255,255,255,0.55)";
      c.font = "10px system-ui"; c.textAlign = "left";
      const label = (clip.audioSourceId || "").startsWith("recording_") ? "🎤" : (clip.audioSourceId || "").slice(0, 40);
      c.save(); c.beginPath(); c.rect(x, y, cw, ch); c.clip();
      c.fillText(label, Math.max(x, 0) + 6, y + 12);
      if (clip.linkedMarkerId || clip.linkedEqMarkerId) c.fillText("🔗", Math.max(x, 0) + 6, y + ch - 4);
      c.restore();
    }
  }

  // Duchy przeciąganych klipów
  if (ghost) {
    const primary = s.clips.find((cl) => cl.id === ghost.clipId);
    if (primary) {
      const pIdx = trackIndex.get(primary.trackId);
      const gIdx = trackIndex.get(ghost.trackId);
      const tDelta = gIdx - pIdx;
      const bDelta = ghost.beat - primary.startBeat;
      const list = s.selectedClipIds.has(ghost.clipId) ? s.clips.filter((cl) => s.selectedClipIds.has(cl.id)) : [primary];
      for (const gc of list) {
        const ti = clamp(trackIndex.get(gc.trackId) + tDelta, 0, s.tracks.length - 1);
        const gx = (gc.startBeat + bDelta) * ep + camX;
        const gy = ti * TRACK_H + pad;
        const gw = gc.durationBeats * ep, gh = TRACK_H - pad * 2;
        c.fillStyle = "rgba(129,140,248,0.7)";
        roundRect(c, gx, gy, gw, gh, 6); c.fill();
        c.strokeStyle = "#FBBF24"; c.lineWidth = 3;
        roundRect(c, gx, gy, gw, gh, 6); c.stroke();
      }
    }
  }

  // Nagrywanie w toku
  if (s.recordingTrackId) {
    const idx = trackIndex.get(s.recordingTrackId);
    if (idx != null) {
      const sx = beatToX(s.recordingStartBeat), cx = beatToX(tl.currentPlayheadBeat);
      c.fillStyle = "rgba(239,68,68,0.4)";
      roundRect(c, sx, idx * TRACK_H + pad, Math.max(0, cx - sx), TRACK_H - pad * 2, 6); c.fill();
    }
  }

  // Linie korytarzy
  c.strokeStyle = "rgba(255,255,255,0.05)"; c.lineWidth = 1;
  c.beginPath();
  for (let i = 0; i <= s.tracks.length; i++) { c.moveTo(0, i * TRACK_H); c.lineTo(w, i * TRACK_H); }
  c.stroke();
  c.restore();

  // Głowica i Breakery (na całą wysokość widoku)
  const px = beatToX(tl.currentPlayheadBeat);
  if (px >= 0 && px <= w) {
    c.strokeStyle = "#EF4444"; c.lineWidth = 2;
    c.beginPath(); c.moveTo(px, 0); c.lineTo(px, Math.min(hh, totalH - scrollY)); c.stroke();
  }
  c.setLineDash([15, 15]);
  c.lineWidth = 3;
  for (const m of tl.loopMarkers) {
    const x = beatToX(m.beat);
    if (x < 0 || x > w) continue;
    c.strokeStyle = "rgba(59,130,246,0.6)";
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, Math.min(hh, totalH - scrollY)); c.stroke();
  }
  for (const m of tl.starterMarkers) {
    const x = beatToX(m.beat);
    if (x < 0 || x > w) continue;
    c.strokeStyle = "rgba(16,185,129,0.5)";
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, Math.min(hh, totalH - scrollY)); c.stroke();
  }
  c.setLineDash([]);
}

// ---------------------------------------------------------------- Linijka (ruler)

function markerAt(x, tolerance = 20) {
  const tl = chronos.tl;
  let best = null, bestD = tolerance;
  for (const m of tl.loopMarkers) { const d = Math.abs(beatToX(m.beat) - x); if (d < bestD) { best = { kind: "breaker", m }; bestD = d; } }
  for (const m of tl.starterMarkers) { const d = Math.abs(beatToX(m.beat) - x); if (d < bestD) { best = { kind: "starter", m }; bestD = d; } }
  return best;
}

function setupRuler() {
  let st = null, longTimer = null;
  const longPress = (x) => {
    const hit = markerAt(x, 24);
    if (hit) openEditMarkerDialog(hit.m, hit.kind);
    else openAddMarkerDialog(quantize(xToBeat(x), 1));
  };
  ruler.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    e.preventDefault();
    ruler.setPointerCapture(e.pointerId);
    document.activeElement?.blur?.();
    const x = e.offsetX;
    const hit = markerAt(x);
    st = { x, y: e.offsetY, moved: false, hit, long: false };
    clearTimeout(longTimer);
    longTimer = setTimeout(() => { if (st && !st.moved) { st.long = true; longPress(x); } }, 550);
  });
  ruler.addEventListener("pointermove", (e) => {
    if (!st) return;
    if (!st.moved && Math.abs(e.offsetX - st.x) > 6) { st.moved = true; clearTimeout(longTimer); }
    if (!st.moved) return;
    if (st.hit) {
      const b = quantize(xToBeat(e.offsetX), 1);
      st.hit.kind === "breaker" ? chronos.updateLoopMarker(st.hit.m.id, b) : chronos.updateStarterMarker(st.hit.m.id, b);
      drag = { kind: "marker" };
    } else {
      chronos.seekToBeat(xToBeat(e.offsetX));
    }
  });
  const end = (e) => {
    clearTimeout(longTimer);
    if (st && !st.moved && !st.long && e.type === "pointerup") chronos.seekToBeat(xToBeat(st.x));
    st = null; drag = null; dirty = true;
  };
  ruler.addEventListener("pointerup", end);
  ruler.addEventListener("pointercancel", end);
  ruler.addEventListener("contextmenu", (e) => { e.preventDefault(); clearTimeout(longTimer); st = null; longPress(e.offsetX); });
  ruler.addEventListener("wheel", (e) => onWheel(e), { passive: false });
}

// ---------------------------------------------------------------- Główny obszar (gesty)

function hitClip(x, y) {
  const s = chronos.s;
  const idx = Math.floor((y + scrollY) / TRACK_H);
  const tr = s.tracks[idx];
  if (!tr) return { track: null, clip: null };
  const ep = effP();
  // Ostatni narysowany (na wierzchu) wygrywa
  let clip = null;
  for (const cl of s.clips) {
    if (cl.trackId !== tr.id) continue;
    const x0 = cl.startBeat * ep + camX, x1 = (cl.startBeat + cl.durationBeats) * ep + camX;
    if (x >= x0 && x <= x1) clip = cl;
  }
  return { track: tr, clip };
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const old = zoomX;
    zoomX = clamp(zoomX * Math.exp(-e.deltaY * 0.01), 0.2, 5);
    const bx = (e.offsetX - camX) / (PX_PER_BEAT * old);
    camX = e.offsetX - bx * PX_PER_BEAT * zoomX;
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    camX -= e.shiftKey ? e.deltaY : e.deltaX;
  } else {
    scrollY += e.deltaY;
  }
  camX = Math.min(camX, 60);
  applyScroll();
}

function setupMain() {
  const pointers = new Map();
  let st = null;
  let pinch = null;

  main.addEventListener("wheel", onWheel, { passive: false });

  main.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    main.setPointerCapture(e.pointerId);
    document.activeElement?.blur?.();
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      st = null; ghost = null; drag = null;
      return;
    }
    const mode = chronos.s.toolMode;
    st = { x: e.offsetX, y: e.offsetY, t: performance.now(), moved: false, camX, scrollY, action: "pan" };
    if (mode === ToolMode.MOVE) {
      const phX = beatToX(chronos.tl.currentPlayheadBeat);
      if (Math.abs(e.offsetX - phX) < 24) { st.action = "playhead"; drag = { kind: "playhead" }; return; }
      const { clip } = hitClip(e.offsetX, e.offsetY);
      if (clip) {
        st.action = "clip";
        st.clip = clip;
        st.origBeat = clip.startBeat;
      } else st.action = "none";
    }
  });

  main.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const old = zoomX;
      zoomX = clamp(zoomX * (dist / Math.max(1, pinch.dist)), 0.2, 5);
      const bx = (cx - camX) / (PX_PER_BEAT * old);
      camX = cx - bx * PX_PER_BEAT * zoomX + (cx - pinch.cx);
      scrollY -= cy - pinch.cy;
      camX = Math.min(camX, 60);
      pinch = { dist, cx, cy };
      applyScroll();
      return;
    }
    if (!st) return;
    const dx = e.offsetX - st.x, dy = e.offsetY - st.y;
    if (!st.moved && Math.hypot(dx, dy) > 6) {
      st.moved = true;
      if (st.action === "clip") {
        const sel = chronos.s.selectedClipIds;
        if (!sel.has(st.clip.id)) chronos.selectClip(st.clip.id);
        chronos.selectTrack(st.clip.trackId);
        ghost = { clipId: st.clip.id, beat: st.clip.startBeat, trackId: st.clip.trackId };
        drag = { kind: "clip" };
      }
    }
    if (!st.moved) return;
    if (st.action === "pan") {
      camX = Math.min(st.camX + dx, 60);
      scrollY = st.scrollY - dy;
      applyScroll();
    } else if (st.action === "playhead") {
      chronos.seekToBeat(xToBeat(e.offsetX));
    } else if (st.action === "clip" && ghost) {
      const tracks = chronos.s.tracks;
      ghost.beat = quantize(st.origBeat + dx / effP(), 0);
      const ti = clamp(Math.floor((e.offsetY + scrollY) / TRACK_H), 0, tracks.length - 1);
      ghost.trackId = tracks[ti].id;
      // Autoprzewijanie przy krawędziach
      if (e.offsetY > main.clientHeight - 20) { scrollY += 6; applyScroll(); }
      else if (e.offsetY < 20) { scrollY -= 6; applyScroll(); }
      dirty = true;
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; st = null; return; }
    if (!st) return;
    if (st.action === "clip" && ghost) {
      if (chronos.s.selectedClipIds.has(ghost.clipId)) chronos.moveSelectedClips(ghost.clipId, ghost.beat, ghost.trackId);
      else chronos.updateClipPosition(ghost.clipId, ghost.beat, ghost.trackId);
    } else if (!st.moved && e.type === "pointerup") {
      onTap(st.x, st.y);
    }
    ghost = null; drag = null; st = null; dirty = true;
  };
  main.addEventListener("pointerup", end);
  main.addEventListener("pointercancel", end);
  main.addEventListener("contextmenu", (e) => e.preventDefault());
}

function onTap(x, y) {
  const s = chronos.s;
  const mode = s.toolMode;
  const { track, clip } = hitClip(x, y);
  if (track) {
    if (clip) {
      if (mode === ToolMode.MULTI_SELECT) chronos.toggleClipSelection(clip.id);
      else { chronos.selectClip(clip.id); chronos.selectTrack(track.id); chronos.setToolMode(ToolMode.PAN); }
    } else {
      if (mode !== ToolMode.MULTI_SELECT) chronos.clearSelection();
      chronos.selectTrack(null);
      if (mode !== ToolMode.MULTI_SELECT) chronos.setToolMode(ToolMode.PAN);
    }
  } else {
    chronos.selectTrack(null);
    chronos.selectClip(null);
    chronos.setToolMode(ToolMode.PAN);
  }
}

// ---------------------------------------------------------------- Panele dolne

function syncPanel() {
  const s = chronos.s;
  let key = null;
  if (s.selectedClipIds.size === 1) {
    const clip = s.clips.find((c) => c.id === [...s.selectedClipIds][0]);
    if (clip && s.tracks.some((tr) => tr.id === clip.trackId)) key = `clip:${clip.id}:${clip.isMuted}:${s.toolMode}:${s.playingClipId === clip.id}:${clip.trackId}`;
  } else if (s.selectedClipIds.size > 1) key = `multi:${s.selectedClipIds.size}:${s.toolMode}`;
  else if (s.selectedTrackId && s.tracks.some((tr) => tr.id === s.selectedTrackId)) key = `track:${s.selectedTrackId}:${s.recordingTrackId === s.selectedTrackId}`;
  if (key === currentPanelKey) return;
  const hadPanel = !!currentPanelKey;
  currentPanelKey = key;
  clear(panelHost);
  if (!key) { panelHost.classList.remove("open"); return; }
  const el = key.startsWith("clip:") ? clipPanel() : key.startsWith("multi:") ? multiPanel() : trackPanel();
  panelHost.appendChild(el);
  if (!hadPanel) { panelHost.classList.remove("open"); void panelHost.offsetWidth; }
  panelHost.classList.add("open");
}

function sheet(title, onClose, ...rows) {
  return h("div.sheet", null,
    h("div.sheet-head", null, h("div.sheet-title", null, title), h("button.icon-btn.small", { type: "button", "aria-label": t("close"), onclick: onClose }, "✕")),
    ...rows);
}

function clipPanel() {
  const s = chronos.s;
  const clip = s.clips.find((c) => c.id === [...s.selectedClipIds][0]);
  const track = s.tracks.find((tr) => tr.id === clip.trackId);
  const playing = s.playingClipId === clip.id;
  const moving = s.toolMode === ToolMode.MOVE;
  const hideLink = h("div.split-action", null,
    h("div.split-btn", null,
      h("button.split-main", { type: "button", title: t("c_hide_link"), style: { color: clip.isMuted ? "#888" : "#3B82F6" }, onclick: () => chronos.toggleClipMute(clip.id) }, clip.isMuted ? "🙈" : "👁"),
      h("button.split-sub", { type: "button", title: "Link", onclick: () => openLinkMarkerDialog(clip) }, "⚙")),
    h("span.action-label", null, t("c_hide_link")));
  return sheet(`${t("recording_on")}: ${track?.name ?? ""}`, () => chronos.clearSelection(),
    h("div.sheet-row", null,
      actionButton(playing ? t("c_stop") : t("c_play"), playing ? "■" : "▶", playing ? "#EF4444" : "#22C55E", () => chronos.toggleClipPlayback(clip)),
      actionButton(t("c_duplicate"), "⧉", "#A855F7", () => chronos.duplicateClip(clip.id)),
      actionButton(t("c_editor"), "🎚", "#3B82F6", () => openClipEditor(chronos.s.clips.find((c) => c.id === clip.id)))),
    h("div.sheet-row", null,
      moving
        ? actionButton(t("c_done"), "✔", "#10B981", () => chronos.setToolMode(ToolMode.PAN))
        : actionButton(t("c_move"), "✥", "#10B981", () => chronos.setToolMode(ToolMode.MOVE)),
      actionButton(t("c_delete"), "🗑", "#EF4444", () => confirmDeleteClip(clip)),
      hideLink));
}

function confirmDeleteClip(clip) {
  cdialog({
    title: t("delete_recording"),
    content: h("p.muted", null, t("delete_recording_confirm")),
    actions: [
      { label: t("cancel_lc"), variant: "text" },
      { label: t("delete"), variant: "danger", onClick: () => chronos.removeClip(clip.id) },
    ],
  });
}

function multiPanel() {
  const s = chronos.s;
  const moving = s.toolMode === ToolMode.MOVE;
  return sheet(t("mass_edit", { n: s.selectedClipIds.size }), () => chronos.clearSelection(),
    h("div.sheet-row", null,
      actionButton(t("copy_all"), "⧉", "#A855F7", () => chronos.duplicateSelectedClips()),
      moving
        ? actionButton(t("c_done"), "✔", "#10B981", () => chronos.setToolMode(ToolMode.PAN))
        : actionButton(t("move_group"), "✥", "#10B981", () => chronos.setToolMode(ToolMode.MOVE)),
      actionButton(t("delete_all"), "🗑", "#EF4444", () => chronos.deleteSelectedClips())));
}

function trackPanel() {
  const s = chronos.s;
  const track = s.tracks.find((tr) => tr.id === s.selectedTrackId);
  const rec = s.recordingTrackId === track.id;
  return sheet(`${t("new_recording")}: ${track.name}`, () => chronos.selectTrack(null),
    h("div.sheet-row", null,
      actionButton(rec ? t("c_stop") : t("record_here"), rec ? "■" : "🎤", rec ? "#fff" : "#EF4444", async () => {
        try {
          if (rec) await chronos.stopTrackRecording(track.id);
          else await chronos.startTrackRecording(track.id);
        } catch (e) {
          if (e instanceof MicDeniedError) toast(t("mic_denied"));
          else if (e instanceof MicUnavailableError) toast(t("mic_unavailable"));
          else toast(String(e?.message || e));
        }
      }, rec ? "recording" : "")));
}

function syncBusy() {
  if (chronos.s.isImporting && !busyEl) { busyEl = spinnerOverlay(t("processing_track")); root.appendChild(busyEl); }
  else if (!chronos.s.isImporting && busyEl) { busyEl.remove(); busyEl = null; }
}

export function chronosRedraw() { computeMetrics(); resize(); }
