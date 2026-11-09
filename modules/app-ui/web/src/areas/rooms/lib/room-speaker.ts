// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors

import type { WireMessage } from "@shared/wire";

const day = (at: number | undefined) => (at === undefined ? "" : new Date(at).toDateString());

export const speakerOf = (m: WireMessage): string => String((m.extra as { speaker?: unknown } | undefined)?.speaker ?? "");

/** A line shows its speaker's name unless the line before it is from the same speaker on the same day. */
export function showsSpeaker(messages: readonly WireMessage[], index: number): boolean {
  const message = messages[index];
  if (!message) return false;
  const prev = messages[index - 1];
  if (!prev) return true;
  if (speakerOf(prev) !== speakerOf(message)) return true;
  return day(prev.createdAt) !== day(message.createdAt);
}
