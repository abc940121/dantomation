// The rooms area: the rooms module's rooms as groups. Our own file (MIT).
import { registerArea } from "@/areas/registry";
import { GroupMain } from "./GroupMain";
import { RoomsSection } from "./RoomsSection";
import { GROUP_VIEW, roomsSlice, startRooms } from "./state";
import { en, zhTw } from "./strings";

registerArea({
  id: "rooms",
  strings: { en, "zh-tw": zhTw },
  slices: { rooms: roomsSlice },
  views: [
    { slot: "sidebar-section", id: "rooms", priority: 10, component: RoomsSection },
    { slot: "main-view", id: GROUP_VIEW, component: GroupMain },
  ],
  start: (api) => startRooms(api),
});
