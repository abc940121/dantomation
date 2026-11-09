// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
// Day separators between the days of a conversation (derived from OpenMausBot's transcript derivations).
import { activeLocale, t } from "@/lib/i18n";

export function localDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

let dates: { locale: string; format: (at: number) => string } | null = null;

export function dayLabel(at: number, today = localDay(Date.now())): string {
  const daysAgo = today - localDay(at);
  if (daysAgo === 0) return t("chat.day.today");
  if (daysAgo === 1) return t("chat.day.yesterday");
  if (Number.isNaN(daysAgo)) return "";
  const locale = activeLocale();
  if (dates?.locale !== locale) {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" });
    dates = { locale, format: (value) => formatter.format(value) };
  }
  return dates.format(at);
}

export function formatTime(at: number): string {
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat(activeLocale(), { hour: "numeric", minute: "2-digit" }).format(at);
}

/** True when a day separator belongs before `current` (the first message, or a new local day). */
export function startsNewDay(previous: number | undefined, current: number): boolean {
  if (!Number.isFinite(current) || current <= 0) return false;
  return previous === undefined || !Number.isFinite(previous) || previous <= 0 || localDay(previous) !== localDay(current);
}
