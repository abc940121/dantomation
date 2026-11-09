// The foundation 'thread' view: plain text bubbles, a working line, older history. Our own file (MIT).
// An area (markdown) replaces it by registering a 'thread' view with a higher priority.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WireMessage } from "@shared/wire";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";

const EMPTY: WireMessage[] = [];

export function BasicThread({ botId }: { botId: string }) {
  const { useStore, client, dispatch, t } = useArea();
  const messages = useStore((s) => s.messages[botId]) ?? EMPTY;
  const activity = useStore((s) => s.activity[botId]) ?? EMPTY;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [more, setMore] = useState(true);

  const running = activity.filter((m) => m.tool?.running);
  const last = messages[messages.length - 1]?.id;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last, messages.length, running.length, botId]);

  useEffect(() => {
    stick.current = true;
    setMore(true);
  }, [botId]);

  async function older() {
    const first = messages[0]?.id;
    if (!first) return;
    try {
      const r = await client.get<{ messages: WireMessage[] }>(`/m/app-ui/api/bots/${encodeURIComponent(botId)}/messages?limit=50&before=${encodeURIComponent(first)}`);
      if (!r.messages.length) setMore(false);
      dispatch({ type: "history", botId, messages: r.messages });
    } catch {
      setMore(false);
    }
  }

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {messages.length > 0 && more && (
          <button type="button" onClick={() => void older()} className="mx-auto min-h-9 rounded-md px-3 text-xs text-ink-secondary hover:bg-raised-hover">
            {t("app.thread.older")}
          </button>
        )}
        {messages.length === 0 && <p className="py-10 text-center text-sm text-ink-secondary">{t("app.thread.empty")}</p>}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap",
                m.role === "user" ? "bg-bubble-user text-ink" : "bg-card text-ink",
              )}
            >
              {m.text}
            </div>
          </div>
        ))}
        {running.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-ink-secondary" role="status">
            <span className="h-2 w-2 animate-status-pulse rounded-full bg-warning" />
            <span className="truncate">{running[running.length - 1]!.tool?.summary || t("app.thread.working")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
