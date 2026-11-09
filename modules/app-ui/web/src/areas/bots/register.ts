// Registers the bots area: settings modal, per-bot dialog, onboarding gate, config slice. Our own file (MIT).
import { registerArea } from "@/areas/registry";
import { AboutPage } from "./AboutPage";
import { BotSettingsDialog } from "./BotSettingsDialog";
import { BotSettingsButton, SettingsButton } from "./HeaderButtons";
import { GeneralSettings } from "./GeneralSettings";
import { OnboardingGate } from "./Onboarding";
import { SettingsModal } from "./SettingsModal";
import { configSlice, startSettings } from "./settings-store";
import { en, zhTw } from "./strings";

registerArea({
  id: "bots",
  strings: { en, "zh-tw": zhTw },
  slices: { config: configSlice },
  views: [
    { slot: "header-action", id: "bot-settings", priority: 10, component: BotSettingsButton },
    { slot: "header-action", id: "settings", priority: 20, component: SettingsButton },
    { slot: "overlay", id: "settings", component: SettingsModal },
    { slot: "overlay", id: "bot-settings", component: BotSettingsDialog },
    { slot: "settings-page", id: "general", priority: 0, component: GeneralSettings },
    { slot: "settings-page", id: "about", priority: 100, component: AboutPage },
    { slot: "gate", id: "onboarding", priority: 0, component: OnboardingGate },
  ],
  start: startSettings,
});
