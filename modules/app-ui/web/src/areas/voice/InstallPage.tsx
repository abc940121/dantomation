// Settings page "Install" (our own file, MIT): the install button, an iOS hint, and the HTTPS warning.
import { useEffect, useState } from "react";
import { useArea } from "../registry";

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

/** Called once at start: keeps the browser's install offer so the settings page can use it later. */
export function captureInstallPrompt(): () => void {
  const onPrompt = (e: Event) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((fn) => fn());
  };
  const onInstalled = () => {
    deferred = null;
    listeners.forEach((fn) => fn());
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
}

export function InstallPage() {
  const { t } = useArea();
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);

  const secure = window.isSecureContext;
  const install = async () => {
    const offer = deferred;
    if (!offer) return;
    deferred = null;
    await offer.prompt();
    await offer.userChoice.catch(() => null);
    bump((n) => n + 1);
  };

  return (
    <section className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{t("install.title")}</h2>
      <p className={secure ? "text-sm text-ink-secondary" : "text-sm text-red-400"}>{secure ? t("install.secure") : t("install.insecure")}</p>
      {isStandalone() ? (
        <p className="text-sm text-ink-secondary">{t("install.installed")}</p>
      ) : deferred ? (
        <button type="button" onClick={() => void install()} className="min-h-10 rounded-lg bg-raised px-4 text-sm hover:bg-raised-hover">
          {t("install.button")}
        </button>
      ) : isIos() ? (
        <p className="text-sm text-ink-secondary">{t("install.ios")}</p>
      ) : (
        <p className="text-sm text-ink-secondary">{t("install.unavailable")}</p>
      )}
    </section>
  );
}
