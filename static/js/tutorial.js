// Port TutorialOverlay.kt + logiki poradnika z MuzartViewModel.
import { h, clear } from "./util.js";
import { t } from "./i18n.js";
import { prefs } from "./storage.js";
import { studio } from "./studio/store.js";
import { checkbox } from "./ui/components.js";

let getTab = () => 1;
let step = null;
let overlay = null;
let promptEl = null;
let raf = null;

export const tutorial = {
  init(tabGetter) { getTab = tabGetter; },
  get preference() { return prefs.get("tutorial_pref", "ASK"); },
  setPreference(p) { prefs.set("tutorial_pref", p); },
  get active() { return step != null; },

  /** checkTutorialStatus — przy starcie i po zmianie zakładki. */
  check() {
    const pref = this.preference;
    if (pref === "ASK") this.showPrompt();
    else if (pref === "SHOW") this.start();
  },

  showPrompt() {
    if (promptEl) return;
    let remember = false;
    const close = () => { promptEl?.remove(); promptEl = null; };
    promptEl = h("div.dlg-backdrop.tutorial-prompt", null,
      h("div.dlg.dlg-sm", { role: "dialog", "aria-modal": "true" },
        h("div.dlg-head", null, h("h2.dlg-title", null, t("tutorial_welcome"))),
        h("div.dlg-body", null,
          h("p", null, t("tutorial_ask")),
          checkbox(t("remember_choice"), false, (v) => { remember = v; })),
        h("div.dlg-actions", null,
          h("button.btn.text", { type: "button", onclick: () => { if (remember) this.setPreference("NEVER_SHOW"); close(); } }, t("skip")),
          h("button.btn.primary", { type: "button", onclick: () => { if (remember) this.setPreference("SHOW"); close(); this.start(); } }, t("start_tutorial")))));
    document.getElementById("overlay-root").appendChild(promptEl);
  },

  dismissPrompt() { promptEl?.remove(); promptEl = null; },

  start() {
    this.dismissPrompt();
    step = 0;
    applyForcedState(0);
    render();
  },

  async next() {
    if (step == null) return;
    const isStudio = getTab() === 0;
    const max = isStudio ? 4 : 3;
    if (step < max - 1) {
      const nextStep = step + 1;
      applyForcedState(nextStep);
      if (isStudio && (nextStep === 2 || nextStep === 3)) {
        step = null; render();
        await new Promise((r) => setTimeout(r, 450));
      }
      step = nextStep;
      render();
    } else this.finish();
  },

  finish() {
    step = null;
    if (this.preference === "SHOW") this.setPreference("NEVER_SHOW");
    cleanup();
    render();
  },

  skip() {
    step = null;
    this.dismissPrompt();
    cleanup();
    render();
  },

  reset() {
    this.setPreference("ASK");
    this.showPrompt();
  },
};

function applyForcedState(s) {
  if (getTab() !== 0) return;
  const rootId = studio.s.rootClock.id;
  if (s === 0) { studio.selectClock(null); studio.setShowSampleEditor(false); }
  else if (s === 1) { studio.selectClock(rootId); studio.setShowSampleEditor(false); }
  else if (s === 2) { studio.selectClock(rootId); studio.setShowSampleEditor(true); }
  else if (s === 3) { studio.setShowSampleEditor(false); }
}

function cleanup() {
  // W Androidzie poradnik zamykał też edytor i panele oraz czyścił zaznaczenie.
  studio.setShowSampleEditor(false);
  studio.selectClock(null);
  document.querySelectorAll(".dlg-backdrop.settings-dialog-backdrop").forEach((d) => d.remove());
}

function stepsFor(tab) {
  return tab === 0
    ? [["tutorial_step1_title", "tutorial_step1_desc"], ["tutorial_step2_title", "tutorial_step2_desc"], ["tutorial_step3_title", "tutorial_step3_desc"], ["tutorial_step5_title", "tutorial_step5_desc"]]
    : [["tut_arr_1_title", "tut_arr_1_desc"], ["tut_arr_2_title", "tut_arr_2_desc"], ["tut_arr_3_title", "tut_arr_3_desc"]];
}

function findTarget(index) {
  const all = [...document.querySelectorAll(`[data-tut="${index}"]`)].filter((el) => el.offsetParent !== null || el.getClientRects().length);
  // Element w otwartym oknie dialogowym ma pierwszeństwo (np. EQ w edytorze sampli).
  return all.find((el) => el.closest(".dlg-backdrop")) || all[0] || null;
}

function render() {
  cancelAnimationFrame(raf);
  if (step == null) { overlay?.remove(); overlay = null; return; }
  const tab = getTab();
  const steps = stepsFor(tab);
  const [titleKey, descKey] = steps[step] || steps[0];
  if (!overlay) {
    overlay = h("div.tut-overlay");
    document.getElementById("overlay-root").appendChild(overlay);
  }
  clear(overlay);
  const hole = h("div.tut-hole");
  const card = h("div.tut-card", null,
    h("h3", null, t(titleKey)),
    h("p", null, t(descKey)),
    h("div.tut-actions", null,
      h("button.btn.text", { type: "button", onclick: () => tutorial.skip() }, t("skip").toUpperCase()),
      h("button.btn.primary", { type: "button", onclick: () => tutorial.next() }, step === steps.length - 1 ? t("finish") : t("next"))));
  overlay.append(hole, card);

  const place = () => {
    if (!overlay) return;
    const target = tab === 0 ? findTarget(step) : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (target) {
      const r = target.getBoundingClientRect();
      hole.hidden = false;
      Object.assign(hole.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      overlay.classList.add("has-hole");
      const cardH = card.offsetHeight || 180;
      let top;
      if (step === 0) top = vh - cardH - 90;
      else if (r.top + r.height / 2 < vh / 2) top = Math.min(vh - cardH - 16, r.bottom + 16);
      else top = Math.max(16, r.top - cardH - 16);
      card.style.top = `${Math.max(16, top)}px`;
      card.style.left = `${Math.max(16, (vw - card.offsetWidth) / 2)}px`;
      card.style.transform = "none";
    } else {
      hole.hidden = true;
      overlay.classList.remove("has-hole");
      card.style.top = "50%"; card.style.left = "50%"; card.style.transform = "translate(-50%, -50%)";
    }
    raf = requestAnimationFrame(place);
  };
  place();
}
