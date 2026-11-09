// The foundation registers itself as an area, so its defaults sit in the same slots areas use.
// Priority 0 everywhere: any area view with a higher priority replaces a single-winner default.
import { registerArea } from "@/areas/registry";
import { PairGate } from "@/dantomation/PairScreen";
import { en, zhTw } from "@/dantomation/strings";
import { BasicComposer } from "./BasicComposer";
import { BasicThread } from "./BasicThread";
import { BotView } from "./BotView";

registerArea({
  id: "foundation",
  strings: { en, "zh-tw": zhTw },
  views: [
    { slot: "gate", id: "pair", priority: -100, component: PairGate },
    { slot: "main-view", id: "bot", component: BotView },
    { slot: "thread", id: "thread", component: BasicThread },
    { slot: "composer", id: "composer", component: BasicComposer },
  ],
});
