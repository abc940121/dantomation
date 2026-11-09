// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary";

/** A name the @ list offers: a room member. `color` is a CSS color, set only by this app. */
export type MentionPeer = { name: string; hidden?: boolean; color?: string };
export type MentionRange = { start: number; end: number; color?: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\r]*)/;
const hideCode = (s: string) => s.replace(/[^\n]/g, " ");

/** `text` with fenced blocks and inline code blanked out, every offset kept, so an @ inside code is not a mention. */
export function blankCode(text: string): string {
  let fence = "";
  const lines = text.split("\n").map((line) => {
    const [, run = "", rest = ""] = FENCE.exec(line) ?? [];
    if (fence) {
      if (run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = "";
      return hideCode(line);
    }
    if (!run || (run[0] === "`" && rest.includes("`"))) return line.replace(/(`+)[^`\n]*?\1/g, hideCode);
    fence = run;
    return hideCode(line);
  });
  return lines.join("\n");
}

export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (!isMentionBoundary(upto, at) || blankCode(text)[at] !== "@") return null;
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

export function mentionChoicesForQuery<T extends { name: string }>(pool: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (query.endsWith(" ") && pool.some((choice) => choice.name.toLowerCase() === normalized)) return [];
  return pool.filter((choice) => !normalized || choice.name.toLowerCase().includes(normalized));
}

export function mentionRanges(text: string, peers: readonly MentionPeer[], everyone = false): MentionRange[] {
  // The longest name wins, as the server reads it.
  const candidates = peers.filter((p) => !p.hidden && p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const peer = candidates.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    const all = everyone && rest.slice(0, 8).toLowerCase() === "everyone" && !isMentionNameContinuation(rest.slice(8));
    const length = all ? 8 : peer?.name.length;
    if (length === undefined) continue;
    const color = !all ? peer?.color : undefined;
    ranges.push({ start: at, end: at + length + 1, ...(color ? { color } : {}) });
    at += length;
  }
  return ranges;
}

export function mentionClassName(): string {
  return "mention-highlight";
}
