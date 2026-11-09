// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary";
import { resolveMentions } from "../shared/room-mentions";
import type { RoomInfo } from "../types";

/** Does the line @-tag everyone? */
export function tagsEveryone(text: string): boolean {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!isMentionBoundary(text, at)) continue;
    if (text.slice(at + 1, at + 9).toLowerCase() === "everyone" && !isMentionNameContinuation(text.slice(at + 9))) return true;
  }
  return false;
}

export type RoomRoute =
  | { kind: "everyone" }
  | { kind: "members"; names: string[] }
  | { kind: "lead"; name: string | null };

/** Who answers this line, as the room reads it: @everyone, then the members it @-tags, then the lead. */
export function roomRouteForComposer(text: string, room: RoomInfo): RoomRoute {
  if (tagsEveryone(text)) return { kind: "everyone" };
  const tagged = resolveMentions(text, room.members).bots;
  if (tagged.length) return { kind: "members", names: tagged.map((m) => m.name) };
  const lead = room.members.find((m) => m.id === room.lead);
  return { kind: "lead", name: lead?.name ?? null };
}

export function routeHint(route: RoomRoute, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (route.kind === "everyone") return t("rooms.hint.everyone");
  if (route.kind === "members") return t("rooms.hint.tagged", { names: route.names.join(", ") });
  return route.name ? t("rooms.hint.lead", { name: route.name }) : t("rooms.hint.leadFallback");
}
