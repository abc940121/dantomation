// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors

import { useArea } from "@/areas/registry";
import { Avatar } from "@/shell/Avatar";
import type { RoomInfo, RoomStatus } from "../types";

/** The room's members, read-only: who they are, who leads, who speaks now. Rooms are edited in the rooms config. */
export function ManageMembersPanel({ room, status }: { room: RoomInfo; status: RoomStatus }) {
  const { t } = useArea();
  return (
    <ul data-testid="room-members" aria-label={t("rooms.members")} className="flex flex-col gap-1 border-b border-hairline bg-panel px-3 py-2">
      {room.members.map((m) => {
        const notes = [
          m.id === room.lead ? t("rooms.lead") : "",
          m.neverLead ? t("rooms.neverLead") : "",
          m.addressedOnly ? t("rooms.addressedOnly") : "",
        ].filter(Boolean);
        return (
          <li key={m.id} className="flex min-h-9 items-center gap-2">
            <Avatar id={m.id} name={m.name} size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{m.name}</span>
              {notes.length ? <span className="block truncate text-xs text-ink-secondary">{notes.join(" · ")}</span> : null}
            </span>
            {status.speaker === m.id ? <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warning animate-status-pulse" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
