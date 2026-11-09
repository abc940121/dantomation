// The gear buttons in the header: app settings, and settings of the selected bot. Our own file (MIT).
import { useArea } from "@/areas/registry";

const btn = "inline-flex size-10 items-center justify-center rounded-lg hover:bg-raised-hover";

function Gear() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function SettingsButton() {
  const { t, openOverlay } = useArea();
  return (
    <button type="button" aria-label={t("bots.settings.open")} title={t("bots.settings.open")} onClick={() => openOverlay("settings")} className={btn}>
      <Gear />
    </button>
  );
}

export function BotSettingsButton() {
  const { t, openOverlay, useStore } = useArea();
  const view = useStore((s) => s.ui.view);
  const botId = useStore((s) => s.ui.selectedBotId);
  if (view !== "bot" || !botId) return null;
  return (
    <button type="button" aria-label={t("bots.bot.open")} title={t("bots.bot.open")} onClick={() => openOverlay("bot-settings", { botId })} className={btn}>
      <span aria-hidden="true" className="text-lg leading-none">
        ...
      </span>
    </button>
  );
}
