// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
import en from "./en.json";

export { en };
export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;

const packLoaders = {
  "zh-tw": () => import("./zh-tw.json"),
} satisfies Record<string, () => Promise<{ default: LocalePack }>>;

export type PackName = "en" | keyof typeof packLoaders;

/** Every language tag the app answers to, and the pack it shows. */
export const localePacks: Readonly<Record<string, PackName>> = {
  en: "en",
  "zh-hant": "zh-tw",
  "zh-hk": "zh-tw",
  "zh-mo": "zh-tw",
  "zh-tw": "zh-tw",
};

/** The packs this page has loaded, under every tag that shows them: English, and each one loadLocalePack fetched. */
export const locales: Record<string, LocalePack> = { en };

export async function loadLocalePack(tag: string): Promise<LocalePack | undefined> {
  const name = localePacks[tag];
  if (locales[tag] || !name || name === "en") return locales[tag];
  const pack: LocalePack = (await packLoaders[name]()).default;
  for (const [alias, shown] of Object.entries(localePacks)) if (shown === name) locales[alias] ??= pack;
  return pack;
}

export const localeChoices: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh-tw", label: "繁體中文（台灣）" },
];
