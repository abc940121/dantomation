// Notification preferences, read state and the browser notification. Our own file (MIT).
// Everything in localStorage sits in try/catch: the page works without it.
const PREFS_KEY = "taskmote.cards.prefs";
const READ_KEY = "taskmote.cards.read";
const READ_CAP = 300;

export interface Prefs {
  browser: boolean;
  questions: boolean;
}
export const DEFAULT_PREFS: Prefs = { browser: false, questions: true };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    return { browser: raw?.browser === true, questions: raw?.questions !== false };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* no storage */
  }
}
export function loadRead(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(-READ_CAP) : [];
  } catch {
    return [];
  }
}
export function saveRead(ids: string[]): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(ids.slice(-READ_CAP)));
  } catch {
    /* no storage */
  }
}

export function notificationState(): "unsupported" | "granted" | "denied" | "default" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** A system notification, only when the user turned it on, the browser allows it and the tab is hidden. */
export function notify(title: string, body: string, tag: string): void {
  try {
    if (!loadPrefs().browser || notificationState() !== "granted" || typeof document === "undefined" || !document.hidden) return;
    new Notification(title, { body, tag });
  } catch {
    /* a notification must never break the app */
  }
}
