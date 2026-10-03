// Wspólne komponenty UI: okna dialogowe, toasty, suwaki, EQ, zakres przycinania.
import { h, clamp, clear } from "../util.js";
import { t } from "../i18n.js";

const overlayRoot = () => document.getElementById("overlay-root");
const openDialogs = [];

/**
 * Okno dialogowe (AlertDialog / Dialog z Compose).
 * @returns {{el: HTMLElement, body: HTMLElement, close: Function, setActions: Function}}
 */
export function dialog({ title, content, actions = [], size = "sm", onClose, dismissible = true, className = "" } = {}) {
  const body = h("div.dlg-body");
  if (content) (Array.isArray(content) ? content : [content]).forEach((c) => c && body.appendChild(c));
  const actionsEl = h("div.dlg-actions");
  const titleEl = title ? h("h2.dlg-title", null, title) : null;
  const closeBtn = h("button.dlg-x", { type: "button", "aria-label": t("close"), onclick: () => close() }, "✕");
  const box = h(`div.dlg.dlg-${size}${className ? "." + className.split(" ").join(".") : ""}`,
    { role: "dialog", "aria-modal": "true" },
    h("div.dlg-head", null, titleEl, dismissible ? closeBtn : null), body, actionsEl);
  const backdrop = h("div.dlg-backdrop", null, box);
  let closed = false;

  function setActions(list) {
    clear(actionsEl);
    list.filter(Boolean).forEach((a) => {
      if (a instanceof Node) { actionsEl.appendChild(a); return; }
      actionsEl.appendChild(h(`button.btn.${a.variant || "text"}`, {
        type: "button",
        disabled: a.disabled,
        onclick: () => { const r = a.onClick?.(); if (r !== false && a.close !== false) close(); },
      }, a.label));
    });
    actionsEl.hidden = actionsEl.childElementCount === 0;
  }
  function close() {
    if (closed) return;
    closed = true;
    backdrop.classList.add("closing");
    const i = openDialogs.indexOf(api);
    if (i >= 0) openDialogs.splice(i, 1);
    setTimeout(() => backdrop.remove(), 150);
    onClose?.();
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop && dismissible) backdrop._downOnBackdrop = true;
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop && dismissible && backdrop._downOnBackdrop) close();
    backdrop._downOnBackdrop = false;
  });
  setActions(actions);
  overlayRoot().appendChild(backdrop);
  const api = { el: box, body, close, setActions, backdrop, dismissible };
  openDialogs.push(api);
  requestAnimationFrame(() => {
    const f = box.querySelector("[autofocus]");
    if (f) f.focus();
  });
  return api;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openDialogs.length) {
    const top = openDialogs[openDialogs.length - 1];
    if (top.dismissible) top.close();
  }
});

export function anyDialogOpen() { return openDialogs.length > 0; }

export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    dialog({
      title,
      content: h("p.muted", null, message),
      actions: [
        { label: cancelLabel || t("cancel_lc"), variant: "text" },
        { label: confirmLabel || "OK", variant: danger ? "danger" : "primary", onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog({ title, label, value = "", confirmLabel }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h("input.input", { type: "text", value, autofocus: true });
    const d = dialog({
      title,
      content: h("label.field", null, h("span.field-label", null, label), input),
      actions: [
        { label: t("cancel"), variant: "text" },
        { label: confirmLabel || t("save"), variant: "primary", onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { result = input.value; d.close(); } });
  });
}

export function toast(message, { action, duration = 3200 } = {}) {
  const root = document.getElementById("toast-root");
  const el = h("div.toast", null, h("span", null, message),
    action ? h("button.btn.text.small", { type: "button", onclick: () => { action.onClick(); dismiss(); } }, action.label) : null);
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  let timer = setTimeout(dismiss, duration);
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }
  return dismiss;
}

/**
 * Pionowy suwak (obsługa myszy, dotyku i klawiatury).
 */
export function vSlider({ value, min = 0, max = 1, step = 0, onInput, onChange, className = "", label = "", color }) {
  const fill = h("div.vs-fill");
  const thumb = h("div.vs-thumb");
  const track = h("div.vs-track", null, fill, thumb);
  const el = h(`div.vslider${className ? "." + className : ""}`, {
    role: "slider", tabindex: "0", "aria-label": label,
    "aria-valuemin": min, "aria-valuemax": max, "aria-orientation": "vertical",
  }, track);
  if (color) el.style.setProperty("--vs-color", color);
  let current = value;

  function render() {
    const r = (current - min) / (max - min);
    fill.style.height = `${r * 100}%`;
    thumb.style.bottom = `calc(${r * 100}% - var(--vs-thumb) / 2)`;
    el.setAttribute("aria-valuenow", current.toFixed(2));
  }
  function setFromY(clientY) {
    const rect = track.getBoundingClientRect();
    let r = 1 - (clientY - rect.top) / rect.height;
    r = clamp(r, 0, 1);
    let v = min + r * (max - min);
    if (step) v = Math.round(v / step) * step;
    v = clamp(v, min, max);
    if (v !== current) { current = v; render(); onInput?.(v); }
  }
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    setFromY(e.clientY);
    const move = (ev) => setFromY(ev.clientY);
    const up = () => {
      el.classList.remove("active");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onChange?.(current);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  el.addEventListener("keydown", (e) => {
    const s = step || (max - min) / 50;
    let v = current;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") v += s;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") v -= s;
    else return;
    e.preventDefault();
    current = clamp(v, min, max);
    render(); onInput?.(current); onChange?.(current);
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    const s = step || (max - min) / 50;
    current = clamp(current + (e.deltaY < 0 ? s : -s), min, max);
    render(); onInput?.(current); onChange?.(current);
  }, { passive: false });
  render();
  el.setValue = (v) => { current = clamp(v, min, max); render(); };
  el.getValue = () => current;
  return el;
}

/** Poziomy suwak — natywny input[type=range] ze stylem. */
export function hSlider({ value, min = 0, max = 1, step = "any", onInput, onChange, className = "" }) {
  const input = h(`input.hslider${className ? "." + className : ""}`, { type: "range", min, max, step });
  input.value = value;
  const paint = () => {
    const r = ((+input.value - min) / (max - min)) * 100;
    input.style.setProperty("--fill", `${r}%`);
  };
  input.addEventListener("input", () => { paint(); onInput?.(+input.value); });
  input.addEventListener("change", () => onChange?.(+input.value));
  paint();
  input.setValue = (v) => { input.value = v; paint(); };
  return input;
}

/** Port ParametricEQ (CommonAudioComponents.kt): 5 pionowych suwaków 0.1–3.0. */
export function parametricEQ(gains, onGainsChange) {
  const labels = ["60Hz", "250Hz", "1kHz", "4kHz", "12kHz"];
  let current = Array.from(gains);
  const wrap = h("div.peq");
  const valueEls = [];
  current.forEach((g, i) => {
    const val = h("div.peq-val", null, `x${g.toFixed(1)}`);
    valueEls.push(val);
    const slider = vSlider({
      value: g, min: 0.1, max: 3, label: labels[i], color: "#06B6D4",
      onInput: (v) => {
        current = current.slice();
        current[i] = Math.max(0.1, v);
        val.textContent = `x${current[i].toFixed(1)}`;
        onGainsChange(Float32Array.from(current));
      },
    });
    wrap.appendChild(h("div.peq-band", null, val, slider, h("div.peq-label", null, labels[i])));
  });
  wrap.setGains = (arr) => {
    current = Array.from(arr);
    wrap.querySelectorAll(".vslider").forEach((s, i) => s.setValue(current[i]));
    valueEls.forEach((v, i) => { v.textContent = `x${current[i].toFixed(1)}`; });
  };
  return wrap;
}

/**
 * Przycinanie: płótno z falą i dwoma uchwytami (zastępuje RangeSlider z Compose).
 * draw(ctx, w, h) rysuje falę; zwraca element z metodami get()/set().
 */
export function trimEditor({ start = 0, end = 1, draw, onChange, height = 160 }) {
  const canvas = h("canvas.trim-canvas");
  const hs = h("div.trim-handle.start", { role: "slider", tabindex: "0", "aria-label": "start" });
  const he = h("div.trim-handle.end", { role: "slider", tabindex: "0", "aria-label": "end" });
  const wrap = h("div.trim", { style: { height: `${height}px` } }, canvas, hs, he);
  let s = start, e = end;

  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const W = rect.width, H = rect.height;
    draw?.(ctx, W, H);
    const x1 = s * W, x2 = e * W;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, x1, H);
    ctx.fillRect(x2, 0, W - x2, H);
    ctx.strokeStyle = "#00FFFF";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
    hs.style.left = `${s * 100}%`;
    he.style.left = `${e * 100}%`;
  }

  function drag(which, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const target = ev.currentTarget;
    target.setPointerCapture?.(ev.pointerId);
    const move = (m) => {
      const rect = canvas.getBoundingClientRect();
      const r = clamp((m.clientX - rect.left) / rect.width, 0, 1);
      if (which === "s") s = Math.min(r, e - 0.005);
      else e = Math.max(r, s + 0.005);
      s = clamp(s, 0, 1); e = clamp(e, 0, 1);
      redraw(); onChange?.(s, e);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    move(ev);
  }
  hs.addEventListener("pointerdown", (ev) => drag("s", ev));
  he.addEventListener("pointerdown", (ev) => drag("e", ev));
  canvas.addEventListener("pointerdown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const r = (ev.clientX - rect.left) / rect.width;
    const which = Math.abs(r - s) < Math.abs(r - e) ? "s" : "e";
    drag(which, Object.assign(ev, {}));
  });
  const key = (which) => (ev) => {
    const d = ev.key === "ArrowLeft" ? -0.01 : ev.key === "ArrowRight" ? 0.01 : 0;
    if (!d) return;
    ev.preventDefault();
    if (which === "s") s = clamp(s + d, 0, e - 0.005); else e = clamp(e + d, s + 0.005, 1);
    redraw(); onChange?.(s, e);
  };
  hs.addEventListener("keydown", key("s"));
  he.addEventListener("keydown", key("e"));

  const ro = new ResizeObserver(() => redraw());
  ro.observe(wrap);
  wrap.redraw = redraw;
  wrap.get = () => [s, e];
  wrap.set = (a, b) => { s = a; e = b; redraw(); };
  return wrap;
}

/** Przycisk-akcja z ikoną i podpisem (TrackActionButton). */
export function actionButton(label, icon, color, onClick, extraClass = "") {
  return h(`button.action-btn${extraClass ? "." + extraClass : ""}`, { type: "button", onclick: onClick, title: label },
    h("span.action-icon", { style: { color } }, icon),
    h("span.action-label", null, label));
}

export function checkbox(label, checked, onChange) {
  const input = h("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label.check", null, input, h("span", null, label));
}

export function radio(name, label, checked, onSelect) {
  const input = h("input", { type: "radio", name });
  input.checked = checked;
  input.addEventListener("change", () => { if (input.checked) onSelect(); });
  return h("label.radio", null, input, h("span", null, label));
}

export function textField(label, value, { onInput, autofocus = false, placeholder = "" } = {}) {
  const input = h("input.input", { type: "text", placeholder, autofocus });
  input.value = value;
  input.addEventListener("input", () => onInput?.(input.value));
  return { el: h("label.field", null, h("span.field-label", null, label), input), input };
}

export function spinnerOverlay(message) {
  return h("div.busy-overlay", null, h("div.spinner"), h("div.busy-text", null, message));
}
