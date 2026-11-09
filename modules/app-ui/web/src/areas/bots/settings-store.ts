// Settings state and its effects (language, theme). Our own file (MIT).
import type { AreaApi } from "@/areas/registry";
import { browserLocale, loadLocale } from "@/lib/i18n";

export type Language = "auto" | "en" | "zh-tw";
export type Appearance = "system" | "light" | "dark";
export interface Config {
  language: Language;
  appearance: Appearance;
  onboarded: boolean;
  profile: { displayName?: string };
}
export interface ConfigSlice {
  loaded: boolean;
  config: Config;
}
export const DEFAULT_CONFIG: Config = { language: "auto", appearance: "system", onboarded: false, profile: {} };
export const API = "/m/app-ui/api";

export const configSlice = {
  initial: { loaded: false, config: DEFAULT_CONFIG } as ConfigSlice,
  reduce(slice: ConfigSlice, action: { type: string; config?: Config }): ConfigSlice {
    return action.type === "config.set" && action.config ? { loaded: true, config: action.config } : slice;
  },
};

/** 'auto' follows the browser; anything else is the chosen pack. */
export function applyLanguage(language: Language): Promise<string> {
  return loadLocale(language === "auto" ? browserLocale() : language);
}

export function resolveSkin(appearance: Appearance): "daylight" | "midnight" {
  if (appearance === "light") return "daylight";
  if (appearance === "dark") return "midnight";
  const dark = typeof window === "undefined" || !window.matchMedia ? true : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "midnight" : "daylight";
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const skin = resolveSkin(appearance);
  root.dataset.theme = skin === "midnight" ? "dark" : "light";
  root.dataset.skin = skin;
}

export function applyConfig(config: Config): void {
  void applyLanguage(config.language);
  applyAppearance(config.appearance);
}

/** Saves a partial config; the server answers with the full one. */
export async function saveConfig(api: AreaApi, patch: Partial<Config>): Promise<Config> {
  const config = await api.client.post<Config>(`${API}/config`, patch);
  api.dispatch({ type: "config.set", config });
  applyConfig(config);
  return config;
}

/** Loads the config, applies it, and keeps 'system' in step with the OS. Returns a cleanup. */
export function startSettings(api: AreaApi): () => void {
  let off = false;
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const onScheme = () => {
    const slice = api.getState().slices.config as ConfigSlice | undefined;
    applyAppearance(slice?.config.appearance ?? "system");
  };
  mq?.addEventListener?.("change", onScheme);
  const known = api.getState().slices.config as ConfigSlice | undefined;
  applyAppearance(known?.loaded ? known.config.appearance : "system");
  api.client
    .get<Config>(`${API}/config`)
    .then((config) => {
      if (off) return;
      api.dispatch({ type: "config.set", config });
      applyConfig(config);
    })
    .catch(() => undefined);
  return () => {
    off = true;
    mq?.removeEventListener?.("change", onScheme);
  };
}
