// Port okna ustawień (Wydajność silnika, Język, Reset poradnika) + opcje wersji web.
import { h, clear, formatBytes } from "./util.js";
import { t, i18n, Languages } from "./i18n.js";
import { dialog, checkbox, hSlider } from "./ui/components.js";
import { studio } from "./studio/store.js";
import { tutorial } from "./tutorial.js";
import { pwa } from "./pwa.js";
import { storageEstimate, requestPersistentStorage } from "./storage.js";

export function openSettings() {
  const body = h("div.settings");
  const d = dialog({ title: t("engine_performance"), size: "sm", className: "settings-dialog", content: body, actions: [{ label: t("close"), variant: "primary" }] });
  d.backdrop.classList.add("settings-dialog-backdrop");
  const unsubs = [i18n.on("change", render), pwa.on("change", render)];
  const close = d.close;
  d.close = () => { unsubs.forEach((u) => u()); close(); };

  function render() {
    clear(body);
    const delay = studio.s.engineDelayMs;
    const opts = [["ultra", 2], ["high", 4], ["standard", 8], ["power_saving", 16]];
    body.appendChild(h("div.opt-list", null, opts.map(([k, v]) =>
      h(`button.opt${delay === v ? ".active" : ""}`, { type: "button", onclick: () => { studio.setEngineDelay(v); render(); } }, t(k)))));

    body.appendChild(h("h3.settings-h", null, t("language")));
    const sel = h("select.input", { onchange: (e) => i18n.setLanguage(e.target.value) },
      Object.values(Languages).map((l) => h("option", { value: l.code, selected: i18n.lang === l.code }, l.label)));
    body.appendChild(sel);

    body.appendChild(h("button.btn.orange.block", { type: "button", onclick: () => { d.close(); tutorial.reset(); } }, t("reset_tutorial")));

    // Wyciszanie tła (Smart Ducking z Androida)
    body.appendChild(h("h3.settings-h", null, t("recording")));
    body.appendChild(checkbox(t("ducking"), studio.s.smartDucking, (v) => studio.setSmartDucking(v)));
    const duckLabel = h("div.slider-label", null, `${Math.round(studio.s.duckingPercentage * 100)}%`);
    body.appendChild(h("div.row", null, hSlider({ value: studio.s.duckingPercentage, min: 0, max: 1, step: 0.05, onInput: (v) => { studio.setDuckingPercentage(v); duckLabel.textContent = `${Math.round(v * 100)}%`; } }), duckLabel));

    // Instalacja
    body.appendChild(h("h3.settings-h", null, t("install_app")));
    if (pwa.installed) body.appendChild(h("p.muted", null, t("installed")));
    else {
      body.appendChild(h("p.muted.small", null, t("install_desc")));
      if (pwa.canPromptInstall) body.appendChild(h("button.btn.primary.block", { type: "button", onclick: () => pwa.promptInstall() }, `📲 ${t("install_btn")}`));
      else body.appendChild(h("p.install-hint", null, pwa.manualInstructions()));
    }

    // Pamięć
    body.appendChild(h("h3.settings-h", null, t("storage")));
    const storageEl = h("p.muted.small", null, "…");
    body.appendChild(storageEl);
    storageEstimate().then((est) => {
      if (est) storageEl.textContent = t("storage_used", { u: formatBytes(est.usage), q: formatBytes(est.quota) });
    });
    requestPersistentStorage();
  }
  render();
}
