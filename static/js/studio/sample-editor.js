// Port SampleEditorDialog.kt — profesjonalny edytor sampli (fala 5-pasmowa, przycinanie, EQ, opóźnienie, prędkość).
import { h } from "../util.js";
import { t } from "../i18n.js";
import { dialog, trimEditor, parametricEQ, hSlider, toast } from "../ui/components.js";
import { engine } from "../audio/engine.js";
import { dsp } from "../audio/dsp-client.js";
import { studio } from "./store.js";

const BANDS = [
  ["Sub", "#E91E63", (p) => p.subBass, 0],
  ["Bass", "#2196F3", (p) => p.bass, 1],
  ["Mid", "#4CAF50", (p) => p.mid, 2],
  ["HighMid", "#FFEB3B", (p) => p.highMid, 3],
  ["Treble", "#FF9800", (p) => p.treble, 4],
];

export function openSampleEditor(node, { onClose } = {}) {
  let [ts, te] = [node.editTrimStart, node.editTrimEnd];
  let delayMs = node.editDelayMs;
  let speed = node.editSpeed;
  let eq = Float32Array.from(node.editEqBands);
  const waveform = node.originalWaveformData || node.waveformData;

  const trim = trimEditor({
    start: ts, end: te,
    height: Math.max(130, Math.min(260, window.innerHeight * 0.25)),
    onChange: (a, b) => { ts = a; te = b; },
    draw: (ctx, w, hgt) => {
      if (!waveform || !waveform.length) return;
      const bw = w / waveform.length;
      ctx.font = "9px system-ui"; ctx.fillStyle = "#888"; ctx.textAlign = "left";
      ctx.fillText("Amplitude", 2, 10);
      ctx.fillText("0.0s", 2, hgt - 4);
      ctx.textAlign = "right";
      ctx.fillText(`${(node.durationMs / 1000).toFixed(2)}s`, w - 2, hgt - 4);
      for (const [, color, ex, idx] of BANDS) {
        ctx.beginPath();
        waveform.forEach((p, i) => {
          const y = hgt / 2 - ex(p) * eq[idx] * hgt * 0.4;
          i === 0 ? ctx.moveTo(i * bw, y) : ctx.lineTo(i * bw, y);
        });
        for (let i = waveform.length - 1; i >= 0; i--) ctx.lineTo(i * bw, hgt / 2 + ex(waveform[i]) * eq[idx] * hgt * 0.4);
        ctx.closePath();
        ctx.globalAlpha = 0.4; ctx.fillStyle = color; ctx.fill();
        ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
      }
    },
  });

  const eqEl = parametricEQ(eq, (g) => { eq = g; trim.redraw(); });
  const eqBox = h("div.eq-box", { "data-tut": "2" }, eqEl);

  const delayLabel = h("div.slider-label", null, `${t("start_delay")}: ${delayMs}ms`);
  const speedLabel = h("div.slider-label", null, `${t("speed")}: ${speed.toFixed(2)}x`);
  const delaySlider = hSlider({ value: delayMs, min: 0, max: 2000, step: 1, onInput: (v) => { delayMs = Math.round(v); delayLabel.textContent = `${t("start_delay")}: ${delayMs}ms`; } });
  const speedSlider = hSlider({ value: speed, min: 0.5, max: 2, step: 0.01, onInput: (v) => { speed = v; speedLabel.textContent = `${t("speed")}: ${speed.toFixed(2)}x`; } });

  const content = [
    h("div.section-label", null, t("waveform_trim")),
    h("div.wave-box", null, trim),
    h("div.section-label", null, t("parametric_eq")),
    eqBox,
    h("div.row.two", null,
      h("div.col", null, delayLabel, delaySlider),
      h("div.col", null, speedLabel, speedSlider)),
  ];

  const d = dialog({
    title: t("prof_sample_editor"),
    size: "lg",
    className: "editor-dialog",
    content,
    onClose: () => { engine.stop("SYSTEM"); onClose?.(); },
    actions: [
      { label: t("cancel"), variant: "text" },
      {
        label: t("preview"), variant: "tonal", close: false,
        onClick: async () => {
          const src = node.originalRawAudioData || node.rawAudioData;
          if (!src) return;
          await engine.unlock();
          const { pcm } = await dsp("process", { pcm: src, trimStart: ts, trimEnd: te, delayMs, speed, eq: Array.from(eq) });
          engine.play("SYSTEM", pcm, 1, { bus: "preview" });
        },
      },
      {
        label: t("save_apply"), variant: "primary",
        onClick: () => {
          studio.applyAudioProcessing(node.id, ts, te, delayMs, speed, eq).catch((e) => toast(String(e.message || e)));
        },
      },
    ],
  });
  requestAnimationFrame(() => trim.redraw());
  return d;
}
