// The rooms slice and its poller (our own file, MIT).
// A tick lists the rooms; when a group is on screen it also fetches the new messages (?since=) and the status.
// A 404 or 403 on the list means the module is off or not allowed: the section hides and polling stops.
import type { AreaApi, SliceDef } from "@/areas/registry";
import { ApiError } from "@/taskmote/client";
import type { Action } from "@/store";
import { cursorOf, mergeMessages, pollDelay, roomMessageToWireMessage, roomToWireGroup } from "../../../../adapter/areas/rooms-map.mjs";
import type { RoomInfo, RoomStatus, RoomsSlice } from "./types";

/** The view id of the group page. The room is in the slice, because a main-view matches ui.view by exact id. */
export const GROUP_VIEW = "group";

export const initialSlice: RoomsSlice = { available: null, rooms: [], messages: {}, status: {}, selected: null, error: null };

export const IDLE: RoomStatus = { busy: false, speaker: null, queue: [], floor: false };

export const roomsSlice: SliceDef<RoomsSlice> = {
  initial: initialSlice,
  reduce(s, a: Action) {
    switch (a.type) {
      case "rooms/list": {
        const rooms = a.rooms as RoomInfo[];
        const selected = s.selected && rooms.some((r) => r.id === s.selected) ? s.selected : null;
        return { ...s, available: true, rooms, selected };
      }
      case "rooms/unavailable":
        return { ...s, available: false, rooms: [], selected: null };
      case "rooms/open":
        return { ...s, selected: a.roomId as string, error: null };
      case "rooms/messages": {
        const roomId = a.roomId as string;
        return { ...s, error: null, messages: { ...s.messages, [roomId]: mergeMessages(s.messages[roomId], a.messages as never[]) } };
      }
      case "rooms/status":
        return { ...s, status: { ...s.status, [a.roomId as string]: a.status as RoomStatus } };
      case "rooms/error":
        return { ...s, error: a.error as string };
      default:
        return s;
    }
  },
};

let kickNow: (() => void) | null = null;
/** Poll right away (after a send). */
export function kickRooms(): void {
  kickNow?.();
}

const base = "/m/rooms/rooms";

interface RawRoom { id: string; lead?: string; window?: number; members?: unknown[] }

export function startRooms(api: AreaApi): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let running = false;
  const slice = () => api.getState().slices.rooms as RoomsSlice | undefined;
  const visible = () => {
    const sl = slice();
    return api.getState().ui.view === GROUP_VIEW && !!sl?.selected && (typeof document === "undefined" || !document.hidden);
  };

  async function fetchOpen(rooms: RoomInfo[]): Promise<void> {
    const sl = slice();
    const id = visible() ? sl?.selected : null;
    const room = id ? rooms.find((r) => r.id === id) : undefined;
    if (!id || !room) return;
    const since = cursorOf(sl?.messages[id]);
    const q = since ? `?since=${encodeURIComponent(since)}` : "";
    const enc = encodeURIComponent(id);
    try {
      const [msgs, st] = await Promise.all([
        api.client.get<{ messages: never[] }>(`${base}/${enc}/messages${q}`),
        api.client.get<Partial<RoomStatus>>(`${base}/${enc}/status`),
      ]);
      const group = roomToWireGroup({ id, lead: room.lead, members: room.members }, st);
      api.dispatch({ type: "rooms/messages", roomId: id, messages: (msgs.messages ?? []).map((m) => roomMessageToWireMessage(m, id)) });
      api.dispatch({ type: "rooms/status", roomId: id, status: { busy: group.busy, speaker: group.speaker, queue: group.queue, floor: group.floor } });
    } catch (e) {
      api.dispatch({ type: "rooms/error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    let unavailable = false;
    try {
      const list = await api.client.get<{ rooms: RawRoom[] }>(base);
      const rooms = (list.rooms ?? []).map((r) => roomToWireGroup(r, undefined)) as RoomInfo[];
      api.dispatch({ type: "rooms/list", rooms });
      await fetchOpen(rooms);
      failures = 0;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403) && slice()?.available !== true) unavailable = true;
      else failures += 1;
    } finally {
      running = false;
    }
    if (unavailable) {
      api.dispatch({ type: "rooms/unavailable" });
      stopped = true;
      return;
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), pollDelay(visible(), failures));
  }

  kickNow = () => {
    if (stopped) return;
    clearTimeout(timer);
    void tick();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    kickNow = null;
  };
}
