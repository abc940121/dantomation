// The bot list plus the 'sidebar-section' slot. Our own file (MIT).
import { listViews } from "@/areas/registry";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { Avatar } from "./Avatar";

const dot: Record<string, string> = { busy: "bg-warning", idle: "bg-success", offline: "bg-ink-tertiary" };

export function Sidebar({ onPick }: { onPick?: () => void }) {
  const { useStore, dispatch, t } = useArea();
  const order = useStore((s) => s.botOrder);
  const bots = useStore((s) => s.bots);
  const selected = useStore((s) => s.ui.selectedBotId);
  const view = useStore((s) => s.ui.view);
  const connection = useStore((s) => s.connection);
  const sections = listViews("sidebar-section");
  const connLabel = connection === "live" ? t("app.live") : connection === "offline" ? t("app.offline") : t("app.connecting");

  return (
    <nav className="flex h-full min-h-0 flex-col bg-panel text-ink" aria-label={t("app.bots")}>
      <div className="px-4 pt-4 pb-2 text-xs font-medium tracking-wide text-ink-tertiary uppercase">{t("app.bots")}</div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {order.length === 0 && <li className="px-2 py-3 text-sm text-ink-secondary">{t("app.noBots")}</li>}
        {order.map((id) => {
          const bot = bots[id];
          if (!bot) return null;
          const active = id === selected && view === "bot";
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: "select", botId: id });
                  onPick?.();
                }}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                  active ? "bg-raised" : "hover:bg-raised-hover",
                )}
              >
                <Avatar id={id} name={bot.name} color={bot.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{bot.name}</span>
                  {bot.description ? <span className="block truncate text-xs text-ink-secondary">{bot.description}</span> : null}
                </span>
                <span className={cn("h-2 w-2 shrink-0 rounded-full", dot[bot.status ?? "idle"] ?? dot.idle, bot.status === "busy" && "animate-status-pulse")} />
              </button>
            </li>
          );
        })}
      </ul>
      {sections.map((v) => (
        <div key={v.id} className="border-t border-hairline">
          <v.component onPick={onPick} />
        </div>
      ))}
      <div className="border-t border-hairline px-4 py-2 text-xs text-ink-tertiary" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        {connLabel}
      </div>
    </nav>
  );
}
