// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import { useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import type { RoomInfo, RoomStatus } from "../types";
import { ManageMembersPanel } from "./ManageMembersPanel";

/** The room's title and a toggle for the read-only member list. No create, edit or delete. */
export function RoomHeader({ room, status }: { room: RoomInfo; status: RoomStatus }) {
  const { t } = useArea();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex min-h-11 items-center gap-2 border-b border-hairline px-3">
        <Users size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{room.name}</h2>
        {status.floor ? <span className="shrink-0 text-xs text-ink-tertiary">{t("rooms.floor")}</span> : null}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-ink-secondary hover:bg-raised-hover"
        >
          {t("rooms.membersCount", { count: room.members.length })}
          <ChevronDown size={12} aria-hidden="true" className={cn(open && "rotate-180")} />
        </button>
      </div>
      {open ? <ManageMembersPanel room={room} status={status} /> : null}
    </>
  );
}
