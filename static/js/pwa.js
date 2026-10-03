// Instalacja aplikacji (PWA) i Service Worker — działanie offline na Android / iOS / macOS / Windows.
import { Emitter, isIOS, isMacSafari, isAndroid, isStandalone } from "./util.js";
import { t } from "./i18n.js";
import { toast } from "./ui/components.js";

export const pwa = new (class extends Emitter {
  constructor() {
    super();
    this.deferredPrompt = null;
    this.installed = isStandalone();
  }
  get canPromptInstall() { return !!this.deferredPrompt; }

  init() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.emit("change");
    });
    window.addEventListener("appinstalled", () => {
      this.installed = true;
      this.deferredPrompt = null;
      this.emit("change");
      toast(t("installed"));
    });
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      window.addEventListener("load", () => this.registerSW());
    }
  }

  async registerSW() {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw?.addEventListener("statechange", () => {
          if (nw.state === "installed") {
            if (hadController) toast(t("update_ready"), { duration: 10000, action: { label: t("reload"), onClick: () => location.reload() } });
            else toast(t("offline_ready"));
          }
        });
      });
      // Sprawdzaj aktualizacje co godzinę, gdy aplikacja jest otwarta.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch (e) {
      console.warn("SW registration failed", e);
    }
  }

  async promptInstall() {
    if (!this.deferredPrompt) return false;
    this.deferredPrompt.prompt();
    const choice = await this.deferredPrompt.userChoice.catch(() => null);
    this.deferredPrompt = null;
    this.emit("change");
    return choice?.outcome === "accepted";
  }

  /** Instrukcja zależna od platformy, gdy przeglądarka nie oferuje okna instalacji. */
  manualInstructions() {
    if (isIOS()) return t("install_ios");
    if (isMacSafari()) return t("install_mac");
    if (isAndroid()) return t("install_android");
    return t("install_mac");
  }
})();
