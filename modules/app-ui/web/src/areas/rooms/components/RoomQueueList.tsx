// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors

import { useArea } from "@/areas/registry";
import type { RoomInfo, RoomStatus } from "../types";

/** The members waiting for a turn, in queue order. */
export function RoomQueueList({ room, status }: { room: RoomInfo; status: RoomStatus }) {
  const { t } = useArea();
  if (!status.queue.length) return null;
  const nameOf = (id: string) => room.members.find((m) => m.id === id)?.name ?? id;
  return (
    <ul data-testid="room-queue" aria-label={t("rooms.queue.title")} className="flex flex-col gap-0.5 ps-10 text-[13px] text-ink-secondary">
      {status.queue.map((id, i) => (
        <li key={`${id}:${i}`}>{t("rooms.queue.member", { name: nameOf(id) })}</li>
      ))}
    </ul>
  );
}
