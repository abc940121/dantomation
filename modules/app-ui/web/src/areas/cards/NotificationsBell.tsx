// The bell in the header, its panel (an overlay) and the notification settings page. Our own file (MIT).
import { useEffect, useState } from "react";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { deriveNotifications } from "../../../../adapter/areas/cards-map.mjs";
import { loadPrefs, notificationState, savePrefs, type Prefs } from "./prefs";
import type { CardsState } from "./register";

function useNotifications() {
  const { useStore } = useArea();
  const st = useStore((s) => s.slices.cards as CardsState);
  const bots = useStore((s) => s.bots);
  const prefs = loadPrefs();
  const open = new Set([...Object.values(st.cards).filter((c) => c.state === "pending").map((c) => c.id), ...Object.values(st.questions).filter((q) => q.state === "pending").map((q) => q.id)]);
  const events = st.events.filter((e) => open.has(e.id) && (prefs.questions || e.type !== "question_pending")).map((e) => ({ ...e, botName: bots[e.bot]?.name ?? e.bot }));
  return deriveNotifications(events, st.readIds);
}

export function NotificationsBell() {
  const { t, openOverlay } = useArea();
  const items = useNotifications();
  const unread = items.filter((n) => !n.read).length;
  return (
    <button
      type="button"
      aria-label={unread ? t("cards.bell.unread", { count: unread }) : t("cards.bell.label")}
      onClick={() => openOverlay("notifications")}
      className="relative inline-flex size-10 items-center justify-center rounded-lg hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 ring-focus"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </svg>
      {unread ? <span className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 text-accent-text">{unread > 9 ? "9+" : unread}</span> : null}
    </button>
  );
}

export function NotificationsPanel({ close }: { close: () => void }) {
  const { t, dispatch, navigate } = useArea();
  const items = useNotifications();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  const go = (id: string, bot: string) => {
    dispatch({ type: "cards/read", ids: [id] });
    dispatch({ type: "select", botId: bot });
    navigate("bot");
    close();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <button type="button" aria-label={t("cards.panel.close")} className="absolute inset-0 bg-black/40" onClick={close} />
      <div role="dialog" aria-label={t("cards.panel.title")} className="relative m-2 flex max-h-[80dvh] w-full max-w-sm flex-col rounded-xl border border-hairline bg-panel shadow-float">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <h2 className="min-w-0 flex-1 text-sm font-medium">{t("cards.panel.title")}</h2>
          <button
            type="button"
            disabled={!items.some((n) => !n.read)}
            onClick={() => dispatch({ type: "cards/read", ids: items.map((n) => n.id) })}
            className="min-h-10 rounded-lg px-2 text-xs text-ink-secondary hover:bg-raised-hover disabled:opacity-40"
          >
            {t("cards.panel.markAll")}
          </button>
        </div>
        <ul className="overflow-y-auto">
          {items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-ink-secondary">{t("cards.panel.empty")}</li> : null}
          {items.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => go(n.id, n.botId)} className="flex w-full flex-col gap-0.5 border-b border-hairline px-3 py-2 text-left hover:bg-raised-hover">
                <span className="flex items-center gap-2 text-xs text-ink-tertiary">
                  <span className={cn("size-2 rounded-full", n.read ? "bg-transparent" : "bg-accent")} />
                  {n.botName} · {t(n.kind === "approval" ? "cards.panel.approval" : "cards.panel.question")}
                </span>
                <span className="text-sm text-ink">{n.title}</span>
                {n.body ? <span className="line-clamp-2 break-words text-xs text-ink-secondary">{n.body}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Row({ label, help, on, onChange, disabled }: { label: string; help: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-xs text-ink-secondary">{help}</span>
      </span>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-5" />
    </label>
  );
}

export function NotificationSettings() {
  const { t } = useArea();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [perm, setPerm] = useState(notificationState);
  const update = (p: Prefs) => {
    setPrefs(p);
    savePrefs(p);
  };
  const setBrowser = async (on: boolean) => {
    if (on && notificationState() === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    update({ ...prefs, browser: on && notificationState() === "granted" });
    setPerm(notificationState());
  };
  const help = perm === "unsupported" ? t("cards.settings.browserUnsupported") : perm === "denied" ? t("cards.settings.browserDenied") : t("cards.settings.browserHelp");
  return (
    <section className="mx-auto w-full max-w-2xl px-4 py-4">
      <h2 className="mb-2 text-base font-medium text-ink">{t("cards.settings.title")}</h2>
      <div className="divide-y divide-hairline rounded-xl border border-hairline bg-card px-3">
        <Row label={t("cards.settings.browser")} help={help} on={prefs.browser} disabled={perm === "unsupported" || perm === "denied"} onChange={(v) => void setBrowser(v)} />
        <Row label={t("cards.settings.questions")} help={t("cards.settings.questionsHelp")} on={prefs.questions} onChange={(v) => update({ ...prefs, questions: v })} />
      </div>
    </section>
  );
}
