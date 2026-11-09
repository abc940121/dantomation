// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
// Derived subset of OpenMausBot's runtime events: the turn lifecycle this app shows.
export type ThreadId = string;
export type TurnId = string;

export interface RuntimeEventBase {
  eventId: string;
  threadId: ThreadId;
  turnId?: TurnId;
  createdAt?: number;
}

export type TurnEndState = "completed" | "done" | "failed" | "stopped";

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "turn.started" }
    | { type: "turn.completed"; state: TurnEndState }
  );
