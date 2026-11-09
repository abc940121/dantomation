// The 'group' main view: the open room as an OpenMausBot-style group. Our own file (MIT).
// A main-view matches ui.view by exact id, so the view is "group" and the room is slice.selected.
import { useArea } from "@/areas/registry";
import { GroupView } from "./components/GroupView";
import { RoomHeader } from "./components/RoomHeader";
import { IDLE } from "./state";
import type { RoomsSlice } from "./types";

export function GroupMain() {
  const { useStore, t } = useArea();
  const slice = useStore((s) => s.slices.rooms as RoomsSlice | undefined);
  const room = slice?.rooms.find((r) => r.id === slice.selected);
  if (!slice || !room) return <p className="m-auto px-4 text-sm text-ink-secondary">{t("rooms.pick")}</p>;
  const status = slice.status[room.id] ?? IDLE;
  return (
    <>
      <RoomHeader key={room.id} room={room} status={status} />
      <GroupView key={room.id} room={room} messages={slice.messages[room.id] ?? []} status={status} error={slice.error} />
    </>
  );
}
