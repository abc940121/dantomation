// The chat package: a richer transcript and composer in the foundation thread and composer slots.
// Our own file (MIT). Priority 10 beats the foundation defaults (0).
import { registerArea } from "@/areas/registry";
import { ChatComposer } from "./ChatComposer";
import { ChatThread } from "./ChatThread";
import { en, zhTw } from "./strings";

registerArea({
  id: "chat",
  strings: { en, "zh-tw": zhTw },
  views: [
    { slot: "thread", id: "chat-thread", priority: 10, component: ChatThread },
    { slot: "composer", id: "chat-composer", priority: 10, component: ChatComposer },
  ],
});
