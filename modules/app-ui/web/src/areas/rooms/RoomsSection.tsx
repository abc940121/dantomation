// The sidebar's Rooms section. Our own file (MIT). Hidden until the rooms module answers, and when it is off.
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { Avatar } from "@/shell/Avatar";
import { GROUP_VIEW, kickRooms } from "./state";
import type { RoomsSlice } from "./types";

export function RoomsSection({ onPick }: { onPick?: () => void }) {
  const { useStore, dispatch, navigate, t } = useArea();
  const slice = useStore((s) => s.slices.rooms as RoomsSlice | undefined);
  const view = useStore((s) => s.ui.view);
  if (!slice || slice.available !== true) return null;
  return (
    <div data-testid="rooms-section">
      <div className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-ink-tertiary uppercase">{t("rooms.title")}</div>
      <ul className="max-h-48 overflow-y-auto px-2 pb-2">
        {slice.rooms.length === 0 && <li className="px-2 py-2 text-sm text-ink-secondary">{t("rooms.empty")}</li>}
        {slice.rooms.map((room) => {
          const active = view === GROUP_VIEW && slice.selected === room.id;
          const busy = slice.status[room.id]?.busy;
          return (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: "rooms/open", roomId: room.id });
                  navigate(GROUP_VIEW);
                  kickRooms();
                  onPick?.();
                }}
                aria-current={active ? "true" : undefined}
                className={cn("flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors", active ? "bg-raised" : "hover:bg-raised-hover")}
              >
                <Avatar id={room.id} name={room.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{room.name}</span>
                  <span className="block truncate text-xs text-ink-secondary">{t("rooms.membersCount", { count: room.members.length })}</span>
                </span>
                {busy ? <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warning animate-status-pulse" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
