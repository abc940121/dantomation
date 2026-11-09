// Shapes of the rooms module's JSON and of this area's slice (our own file, MIT).
import type { WireMessage } from "@shared/wire";

export interface RoomMember {
  id: string;
  name: string;
  neverLead: boolean;
  addressedOnly: boolean;
}

export interface RoomStatus {
  busy: boolean;
  speaker: string | null;
  queue: string[];
  floor: boolean;
}

export interface RoomInfo {
  id: string;
  name: string;
  threadId: string;
  lead: string | null;
  members: RoomMember[];
}

export interface RoomsSlice {
  /** null until the first list answers; false when the module is off (the section hides). */
  available: boolean | null;
  rooms: RoomInfo[];
  messages: Record<string, WireMessage[]>;
  status: Record<string, RoomStatus>;
  /** The room the group view shows. */
  selected: string | null;
  /** Set when the open room's last fetch failed. */
  error: string | null;
}
