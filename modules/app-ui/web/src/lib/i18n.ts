// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
import { en, loadLocalePack, localeChoices, localePacks, locales, type LocaleKey, type LocalePack } from "@/locales";
import { productName } from "@/lib/brand";

// Strings the areas register (registerStrings), by locale pack name ("en", "zh-tw").
const areaPacks: Record<string, Record<string, string>> = { en: {}, "zh-tw": {} };

/** An area adds its own strings; t() looks here first, then the OMB pack, then returns the key. */
export function registerStrings(packs: Record<string, Record<string, string>>): void {
  for (const [name, strings] of Object.entries(packs)) areaPacks[name] = { ...(areaPacks[name] ?? {}), ...strings };
}

export function resolveLocale(tag: string | undefined, available: ReadonlySet<string>): string {
  if (!tag) return "en";
  let candidate = tag.toLowerCase();
  while (candidate) {
    if (available.has(candidate)) return candidate;
    const separator = candidate.lastIndexOf("-");
    if (separator < 0) break;
    candidate = candidate.slice(0, separator);
  }
  return "en";
}

/** Every tag a pack is shown for, loaded or not. */
export function knownLocales(): Set<string> {
  return new Set([...Object.keys(localePacks), ...Object.keys(locales)]);
}

/** Shows `tag`'s language when its pack is loaded (loadLocale), English otherwise; returns the locale that took effect. */
export function setLocale(tag: string | undefined): string {
  switches += 1;
  return show(resolveLocale(tag, new Set(Object.keys(locales))));
}

/** Loads `tag`'s pack and shows it, unless another language was asked for meanwhile. Resolves to the locale shown. */
export async function loadLocale(tag: string | undefined): Promise<string> {
  const asked = ++switches;
  await loadLocalePack(resolveLocale(tag, knownLocales())).catch(() => undefined);
  return asked === switches ? show(resolveLocale(tag, new Set(Object.keys(locales)))) : active;
}

function packName(resolved: string): string {
  return localePacks[resolved] ?? "en";
}

function show(resolved: string): string {
  activePack = locales[resolved] ?? en;
  active = resolved;
  activeArea = packName(resolved);
  const root = typeof document === "undefined" ? undefined : document?.documentElement;
  if (root) root.lang = documentLanguage(resolved);
  for (const fn of listeners) fn();
  return resolved;
}

export function documentLanguage(code: string): string {
  const pack = localePacks[code];
  const shown = (pack && localeChoices.find((choice) => localePacks[choice.code] === pack)?.code) || code;
  return shown
    .split("-")
    .map((part, index) =>
      index === 0 ? part.toLowerCase()
        : part.length === 2 ? part.toUpperCase()
          : part.length === 4 ? part[0]!.toUpperCase() + part.slice(1).toLowerCase()
            : part.toLowerCase())
    .join("-");
}

/** React cannot see the module variable t() reads, so memoized subtrees take this as a prop. */
export function activeLocale(): string {
  return active;
}

export function intlLocale(): string {
  return documentLanguage(active);
}

export function activePackComplete(): boolean {
  return activePack !== en && Object.keys(en).every((key) => Object.hasOwn(activePack, key));
}

/** Called after every language switch (the store uses it to re-render). Returns the unsubscribe. */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The language for this browser: zh-Hant, zh-TW, zh-HK and zh-MO show Traditional Chinese, everything else English. */
export function browserLocale(): string {
  const tag = typeof navigator === "undefined" ? undefined : navigator.language;
  return resolveLocale(tag, new Set(["en", "zh-hant", "zh-tw", "zh-hk", "zh-mo"]));
}

let active = "en";
let activePack: LocalePack = en;
let activeArea = "en";
let switches = 0;
const listeners = new Set<() => void>();

function fill(template: string, params?: Record<string, string | number>): string {
  if (!params && !template.includes("{app}")) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : name === "app" ? productName() : match,
  );
}

/** Area strings first, then the OMB pack (active, then English), then the key itself. */
export function t(key: LocaleKey | (string & {}), params?: Record<string, string | number>): string {
  const area = areaPacks[activeArea]?.[key] ?? areaPacks.en?.[key];
  if (area !== undefined) return fill(area, params);
  const template = (activePack as Record<string, string | undefined>)[key] ?? (en as Record<string, string>)[key];
  return template === undefined ? key : fill(template, params);
}
