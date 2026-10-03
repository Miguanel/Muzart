// Muzart Web — punkt wejścia (odpowiednik MainActivity.kt).
import { t, i18n, applyStaticTranslations } from "./i18n.js";
import { engine } from "./audio/engine.js";
import { studio } from "./studio/store.js";
import { chronos } from "./chronos/store.js";
import { mountStudio, studioRedraw } from "./studio/view.js";
import { mountChronos, chronosRedraw } from "./chronos/view.js";
import { tutorial } from "./tutorial.js";
import { pwa } from "./pwa.js";
import { toast } from "./ui/components.js";
import { requestPersistentStorage } from "./storage.js";

const TAB_STUDIO = 0;
const TAB_CHRONOS = 1;
let currentTab = TAB_CHRONOS; // Domyślnie Aranżer — jak w aplikacji Android

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setProgress(p, key) {
  document.getElementById("init-progress-bar").style.width = `${p * 100}%`;
  document.getElementById("init-status").textContent = t(key);
}

async function init() {
  document.documentElement.lang = i18n.lang;
  pwa.init();
  applyStaticTranslations();

  // Sekwencja startowa (performInitialization)
  setProgress(0.2, "init_audio");
  engine.init();
  await sleep(250);

  setProgress(0.4, "init_libs");
  await studio.loadLibraryFromDisk();
  await sleep(200);

  setProgress(0.7, "init_scenes");
  const restoredStudio = await studio.restoreSession();
  const restoredChronos = await chronos.restoreSession();
  chronos.ensureDefaultTracks();
  chronos.applyBusVolumes();
  await sleep(200);

  setProgress(1.0, "init_ui");
  const params = new URLSearchParams(location.search);
  if (params.get("tab") === "studio") currentTab = TAB_STUDIO;
  mountStudio(document.getElementById("tab-studio"));
  mountChronos(document.getElementById("tab-chronos"));
  setupNav();
  tutorial.init(() => currentTab);
  await sleep(150);

  const initScreen = document.getElementById("init-screen");
  initScreen.classList.add("fade-out");
  document.getElementById("shell").hidden = false;
  showTab(currentTab);
  setTimeout(() => initScreen.remove(), 400);

  studio.startPlaybackEngine();
  tutorial.check();
  if (restoredStudio || restoredChronos) toast(t("restore_session"), { duration: 2000 });
  requestPersistentStorage();
  handleLaunchFiles();

  i18n.on("change", () => applyStaticTranslations());
  window.addEventListener("pagehide", () => { studio.saveSession(); chronos.saveSession(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { studio.saveSession(); chronos.saveSession(); }
  });
}

function setupNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => selectTab(+btn.dataset.tab));
  });
}

function showTab(index) {
  document.getElementById("tab-studio").hidden = index !== TAB_STUDIO;
  document.getElementById("tab-chronos").hidden = index !== TAB_CHRONOS;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", +b.dataset.tab === index));
  requestAnimationFrame(() => (index === TAB_STUDIO ? studioRedraw() : chronosRedraw()));
}

/** selectTab z MuzartViewModel */
function selectTab(index) {
  if (index === currentTab) return;
  if (tutorial.active) tutorial.skip();
  const prev = currentTab;
  currentTab = index;
  if (prev === TAB_STUDIO) studio.saveSession();
  showTab(index);
  tutorial.check();
}

/** Otwieranie plików .mzt z systemu (PWA file_handlers). */
function handleLaunchFiles() {
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    for (const handle of params.files || []) {
      try {
        const file = await handle.getFile();
        const name = await chronos.importProjectFile(file);
        await chronos.loadProject(name);
        selectTab(TAB_CHRONOS);
        toast(t("project_imported", { n: name }));
      } catch (e) { console.error(e); toast(t("import_failed")); }
    }
  });
}

window.addEventListener("error", (e) => console.error("Muzart error:", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => console.error("Muzart promise:", e.reason));

// Uchwyt diagnostyczny (konsola przeglądarki)
window.__muzart = { studio, chronos, engine };

init().catch((e) => {
  console.error(e);
  const s = document.getElementById("init-status");
  if (s) s.textContent = `Error: ${e.message || e}`;
});
