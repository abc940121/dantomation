// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
// Derived subset of OpenMausBot's wire types: the bot, message and frame shapes this app
// uses. Frames are made in the browser by adapter/frames.mjs from the core event stream.

export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
export type BotStatus = "idle" | "busy" | "offline";

export interface WireBot {
  id: string;
  /** The thread the UI shows for this bot: "main:<id>". */
  threadId: string;
  name: string;
  title: string;
  description: string;
  /** A color name or a CSS color; the avatar hashes the id when absent. */
  color?: string;
  status?: BotStatus;
  runsOn?: "main" | "worker";
  engine?: string;
  hidden?: boolean;
  /** A status-only update from a bot_status event: merge it, keep the rest. */
  partial?: boolean;
}

export interface WireTool {
  name: string;
  callId?: string;
  summary?: string;
  ok?: boolean;
  running?: boolean;
}

/** A card with options (approval, question). The cards area renders it. */
export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  expired?: boolean;
  tool?: string;
  requestId?: string;
}

export interface WireMessage {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity";
  text?: string;
  /** Epoch ms, when the server knows it. */
  createdAt?: number;
  /** A reply still being written (the next frame replaces it). */
  streaming?: boolean;
  card?: OptionCardData;
  tool?: WireTool;
  /** Free slot for area data (rooms, reactions, ...). */
  extra?: Record<string, unknown>;
}

export interface WireGroup {
  id: string;
  name: string;
  botIds: string[];
}

export type { RuntimeEvent } from "./runtime-events";
import type { RuntimeEvent } from "./runtime-events";

export type ServerFrame =
  | { kind: "sections"; sections: string[] }
  | { kind: "message"; threadId: string; message: WireMessage }
  | { kind: "message.patch"; threadId: string; message: WireMessage }
  | { kind: "thread"; threadId: string; activeLeafId: string }
  | { kind: "bot"; bot: WireBot }
  | { kind: "bot.deleted"; botId: string }
  | { kind: "group"; group: WireGroup }
  | { kind: "runtime"; event: RuntimeEvent }
  | { kind: "activity"; botId: string; threadId: string; message: WireMessage }
  // local aliases: made by the stream client, not by the server
  | { kind: "hello"; cursor: number; resumed: boolean }
  | { kind: "ping" };

export type FrameOf<K extends ServerFrame["kind"]> = Extract<ServerFrame, { kind: K }>;
/** What an area event mapper may return: any frame, or an area's own action (type + payload). */
export type AreaAction = { type: string; [key: string]: unknown };
