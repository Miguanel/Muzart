// Wspólne narzędzia: zdarzenia, DOM, UUID, matematyka.

export class Emitter {
  constructor() { this._listeners = new Map(); }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this._listeners.get(event)?.delete(fn); }
  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let id = null;
  const wrapped = (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(id); fn(...args); };
  return wrapped;
}

const PROP_KEYS = new Set(["value", "checked", "disabled", "hidden", "textContent", "selected", "multiple"]);

/**
 * Minimalistyczny helper DOM:
 * h("button.btn.primary", { onclick, title }, "Tekst", childNode)
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (PROP_KEYS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isMacSafari = () =>
  /Macintosh/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;
export const isAndroid = () => /Android/i.test(navigator.userAgent);
export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;

/** Długie przytrzymanie (dotyk) lub prawy przycisk myszy -> onLong; krótkie -> onClick. */
export function pressable(el, { onClick, onLong, delay = 500 }) {
  let timer = null, fired = false, sx = 0, sy = 0;
  el.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    fired = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; onLong?.(e); }, delay);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("click", (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; return; } onClick?.(e); });
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!fired) onLong?.(e); fired = false; });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename, style: { display: "none" } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, style: { display: "none" } });
    input.multiple = multiple;
    input.addEventListener("change", () => { resolve(multiple ? [...input.files] : input.files[0] || null); input.remove(); });
    input.addEventListener("cancel", () => { resolve(null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function fmt(n, digits = 2) { return Number(n).toFixed(digits); }
