// Port ClockCanvas.kt — układ, rysowanie i trafianie w zegary fraktalne.
import { childModifier } from "./model.js";

const ColorRoot = "#3498DB";
const ColorChild = "#2ECC71";
const ColorPointer = "#ECF0F1";
const ColorSelected = "#E74C3C";

const rad = (deg) => (deg * Math.PI) / 180;

export function layoutChildren(node, cx, cy, radius) {
  const visible = node.children.filter((c) => c.isVisible);
  if (!visible.length) return [];
  const padding = radius * 0.12;
  const base = 0.45;
  const groups = new Map();
  for (const c of visible) {
    const k = Math.round(c.angleOnParent);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const childRadiusOf = (c) => {
    let r = radius * c.radiusRatio * base;
    if (c.recursiveChildrenCount > 0) r *= 1 / (1 + 0.15 * c.recursiveChildrenCount);
    return Math.max(r, radius * 0.15);
  };

  const layerMap = new Map();
  const l1 = [];
  for (const k of keys) {
    const c = groups.get(k)[0];
    const a = rad(c.angleOnParent - 90);
    const cr = childRadiusOf(c);
    let orbit = radius + cr + padding;
    if (c.recursiveChildrenCount > 0) orbit += cr * 0.6;
    const x = cx + orbit * Math.cos(a);
    const y = cy + orbit * Math.sin(a);
    let collision = false;
    for (const v of l1) {
      if (Math.hypot(x - v.x, y - v.y) < cr + v.r + padding * 0.8) { collision = true; break; }
    }
    if (collision) layerMap.set(k, 2);
    else { layerMap.set(k, 1); l1.push({ x, y, r: cr }); }
  }

  const layouts = [];
  for (const [k, siblings] of groups) {
    const layer = layerMap.get(k) || 1;
    siblings.forEach((c, index) => {
      const a = rad(c.angleOnParent - 90);
      const cr = childRadiusOf(c);
      let orbit = radius + cr + padding;
      if (layer === 2) orbit += cr * 2.5 + padding;
      if (c.recursiveChildrenCount > 0) orbit += cr * 0.6 * layer;
      orbit += index * (cr * 2.5);
      layouts.push({ node: c, cx: cx + orbit * Math.cos(a), cy: cy + orbit * Math.sin(a), r: cr, layer });
    });
  }
  return layouts;
}

export function findClickedClock(node, cx, cy, radius, x, y) {
  if (!node.isVisible) return null;
  const layouts = layoutChildren(node, cx, cy, radius);
  for (let i = layouts.length - 1; i >= 0; i--) {
    const l = layouts[i];
    const hit = findClickedClock(l.node, l.cx, l.cy, l.r, x, y);
    if (hit) return hit;
  }
  const dist = Math.hypot(x - cx, y - cy);
  if (dist <= radius) return { id: node.id, cx, cy, r: radius, isCenter: dist <= radius * 0.3 };
  return null;
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Rysuje drzewo zegarów (drawClockTree).
 * opts: { globalTimeMs, selectedClockId, duplicateTargetId, isEnginePlaying, scale, viewport }
 */
export function drawClockTree(ctx, node, cx, cy, radius, depth, inheritedVolume, opts) {
  if (!node.isVisible || radius < 1) return;
  const { scale, viewport } = opts;

  // Pomijamy rysowanie całkowicie poza ekranem (optymalizacja), ale dzieci mogą wystawać poza rodzica.
  const visibleSelf = !viewport || (cx + radius >= viewport.x0 && cx - radius <= viewport.x1 && cy + radius >= viewport.y0 && cy - radius <= viewport.y1);
  const screenR = radius * scale;

  const isTarget = node.id === opts.duplicateTargetId;
  const isSelected = node.id === opts.selectedClockId;
  let color = isTarget ? "#F39C12" : node.isPaused ? "#7F8C8D" : isSelected ? ColorSelected : depth === 0 ? ColorRoot : ColorChild;
  const colorAlpha = node.isPaused && !isTarget ? 0.5 : 1;

  const baseW = depth === 0 ? 3 : 1.5;
  const outlineW = (isSelected ? 6 : baseW) / scale;
  const centerR = radius * 0.3;
  const actualVol = (node.isMuted ? 0 : node.volumeModifier) * inheritedVolume;

  if (visibleSelf && screenR > 0.6) {
    ctx.lineWidth = outlineW;
    ctx.strokeStyle = withAlpha(color, colorAlpha);
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();

    ctx.fillStyle = isTarget ? "#F1C40F" : node.isPaused ? "#C0392B" : "#2C3E50";
    ctx.beginPath(); ctx.arc(cx, cy, centerR, 0, Math.PI * 2); ctx.fill();

    // Pasek głośności przy środku
    const barW = 6 / scale;
    const barH = centerR * 1.5;
    const barX = cx + centerR * 1.2;
    const barY = cy - barH / 2;
    ctx.fillStyle = "rgba(68,68,68,0.5)";
    ctx.fillRect(barX, barY, barW, barH);
    const ratio = Math.min(1, Math.max(0, actualVol / 2));
    const fillH = barH * ratio;
    ctx.fillStyle = actualVol === 0 ? "#888888" : "#2ECC71";
    ctx.fillRect(barX, barY + (barH - fillH), barW, fillH);

    if (screenR > 8) {
      ctx.textAlign = "center";
      if (node.emoji) {
        const size = centerR * 0.8;
        ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.fillStyle = "#fff";
        ctx.fillText(node.emoji, cx, cy + size / 3);
      }
      if (node.name) {
        const size = centerR * 0.35;
        ctx.font = `${size}px system-ui, sans-serif`;
        ctx.fillStyle = "#fff";
        const y = node.emoji ? cy + centerR * 0.8 : cy + size / 3;
        ctx.fillText(node.name, cx, y);
      }
    }

    // Fala wokół zegara
    const wf = node.waveformData;
    if (wf && wf.length) {
      const total = wf.length;
      const step = depth === 0 ? 1 : 3;
      const count = Math.floor(total / step);
      const baseStroke = Math.max(radius / count, 2);
      ctx.lineWidth = depth === 0 ? baseStroke : 4;
      const baseAlpha = depth === 0 ? 0.4 : 0.7;
      for (let i = 0; i < count; i++) {
        const p = wf[i * step];
        if (!p) continue;
        const a = rad(((i * step) / total) * 360 - 90);
        const amp = Math.min(1, Math.max(0, p.amplitude * actualVol));
        const cos = Math.cos(a), sin = Math.sin(a);
        const inner = radius - amp * (radius - centerR) * 0.8;
        const r = Math.min(1, Math.max(0, p.bass * node.bassBoost));
        const g = Math.min(1, Math.max(0, p.mid));
        const b = Math.min(1, Math.max(0, p.treble));
        let alpha = Math.min(1, Math.max(baseAlpha, amp));
        if (node.isPaused) alpha = 0.2;
        ctx.strokeStyle = `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${alpha})`;
        ctx.beginPath();
        ctx.moveTo(cx + centerR * cos, cy + centerR * sin);
        ctx.lineTo(cx + inner * cos, cy + inner * sin);
        ctx.stroke();
      }
    }

    // Wskazówka postępu
    let progress = null;
    if (depth === 0) progress = opts.isEnginePlaying ? (opts.globalTimeMs % Math.max(1, node.durationMs)) / Math.max(1, node.durationMs) : 0;
    else if (opts.isEnginePlaying && node.lastTriggeredTimeMs != null) {
      const el = opts.globalTimeMs - node.lastTriggeredTimeMs;
      if (el >= 0 && el < node.durationMs) progress = el / node.durationMs;
    }
    if (progress != null && !node.isPaused) {
      const a = rad(progress * 360 - 90);
      ctx.strokeStyle = ColorPointer;
      ctx.lineWidth = outlineW * 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + centerR * Math.cos(a), cy + centerR * Math.sin(a));
      ctx.lineTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
      ctx.stroke();
    }

    // Podział siatki
    if (node.segments > 1) {
      ctx.strokeStyle = withAlpha(color, 0.6 * colorAlpha);
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      for (let i = 0; i < node.segments; i++) {
        const a = rad((i / node.segments) * 360 - 90);
        ctx.moveTo(cx + centerR * Math.cos(a), cy + centerR * Math.sin(a));
        ctx.lineTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
      }
      ctx.stroke();
    }
  }

  for (const l of layoutChildren(node, cx, cy, radius)) {
    ctx.strokeStyle = withAlpha(color, 0.3 * colorAlpha);
    ctx.lineWidth = 2 / scale;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(l.cx, l.cy); ctx.stroke();
    drawClockTree(ctx, l.node, l.cx, l.cy, l.r, depth + 1, inheritedVolume * childModifier(node, l.node), opts);
  }
}

/** Kąt (0–360, 0 = góra) w miejscu kliknięcia względem środka zegara -> indeks slotu siatki. */
export function slotAngleAt(node, hit, x, y) {
  let angle = (Math.atan2(y - hit.cy, x - hit.cx) * 180) / Math.PI + 90;
  if (angle < 0) angle += 360;
  const seg = 360 / node.segments;
  const slot = Math.floor((angle + seg / 2) / seg) % node.segments;
  return slot * seg;
}
