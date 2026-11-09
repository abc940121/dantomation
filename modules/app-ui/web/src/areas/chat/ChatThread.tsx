// The chat transcript: markdown messages, day separators, a working line, tool rows, bottom-follow scrolling,
// a windowed list and paged older history. Our own file (MIT), using the ported pieces beside it.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WireMessage } from "@shared/wire";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ChatMarkdown } from "./components/ChatMarkdown";
import { DaySeparator } from "./components/DaySeparator";
import { JumpToLatestButton } from "./components/JumpToLatestButton";
import { CopyButton, MESSAGE_ROW, MessageActions, RawToggle } from "./components/MessageActions";
import { ToolRow } from "./components/ToolRow";
import { WorkingDots, WorkingTimer } from "./components/WorkingIndicator";
import { shouldResumeBottomFollow, useBottomFollowResize } from "./lib/bottom-follow";
import { localDay, startsNewDay } from "./lib/day";
import { expandWindowStart, resolveTranscriptWindow, tailWindowStart, TRANSCRIPT_WINDOW_SIZE } from "./lib/transcript-window";

const EMPTY: WireMessage[] = [];
const PAGE = 50;

const Row = memo(function Row({ message }: { message: WireMessage }) {
  const [raw, setRaw] = useState(false);
  const mine = message.role === "user";
  const text = message.text ?? "";
  const rowAttr = { [MESSAGE_ROW]: "" };
  return (
    <div {...rowAttr} className={cn("flex items-end gap-1", mine ? "justify-end" : "justify-start")}>
      {mine && text && (
        <MessageActions side="user">
          <CopyButton text={text} />
        </MessageActions>
      )}
      <div
        className={cn(
          "min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words",
          mine ? "bg-bubble-user text-ink" : "bg-card text-ink",
        )}
      >
        {mine || raw ? <span className="whitespace-pre-wrap">{text}</span> : <ChatMarkdown text={text} />}
      </div>
      {!mine && text && (
        <MessageActions side="bot">
          <CopyButton text={text} />
          <RawToggle raw={raw} onToggle={() => setRaw((v) => !v)} />
        </MessageActions>
      )}
    </div>
  );
});

export function ChatThread({ botId }: { botId: string }) {
  const { useStore, client, dispatch } = useArea();
  const messages = useStore((s) => s.messages[botId]) ?? EMPTY;
  const activity = useStore((s) => s.activity[botId]) ?? EMPTY;
  const busy = useStore((s) => s.bots[botId]?.status === "busy");
  const scroller = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [start, setStart] = useState(() => tailWindowStart(messages.length));
  const [since, setSince] = useState(() => Date.now());

  const win = resolveTranscriptWindow(messages, start);
  const last = messages[messages.length - 1];
  const working = busy || activity.some((m) => m.tool?.running);

  useEffect(() => {
    if (working) setSince(Date.now());
  }, [working]);

  // A new bot starts at the bottom, with a fresh window.
  useEffect(() => {
    following.current = true;
    setAway(false);
    setMore(true);
    setStart(tailWindowStart(messages.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  // While following, the window stays on the newest messages.
  useEffect(() => {
    if (following.current) setStart(tailWindowStart(messages.length));
  }, [messages.length]);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  useLayoutEffect(() => {
    if (following.current) toBottom();
  }, [last?.id, last?.text, messages.length, activity.length, botId, toBottom]);

  useBottomFollowResize(scroller, transcript, following, botId);

  async function older() {
    if (win.hiddenCount > 0) {
      setStart(expandWindowStart(win.startIndex, TRANSCRIPT_WINDOW_SIZE));
      return;
    }
    const first = messages[0]?.id;
    if (!first || loading) return;
    setLoading(true);
    try {
      const r = await client.get<{ messages: WireMessage[]; hasMore: boolean }>(
        `/m/app-ui/api/bots/${encodeURIComponent(botId)}/history?limit=${PAGE}&before=${encodeURIComponent(first)}`,
      );
      setMore(r.hasMore && r.messages.length > 0);
      if (r.messages.length) {
        following.current = false;
        setStart(0);
        dispatch({ type: "history", botId, messages: r.messages });
      }
    } catch {
      setMore(false);
    } finally {
      setLoading(false);
    }
  }

  const canOlder = messages.length > 0 && (win.hiddenCount > 0 || more);
  const today = localDay(Date.now());

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (shouldResumeBottomFollow({ following: following.current, previousScrollTop: lastTop.current, scrollTop: el.scrollTop, distanceFromBottom: distance })) {
            following.current = true;
          } else if (el.scrollTop < lastTop.current && distance > 4) {
            following.current = false;
          }
          lastTop.current = el.scrollTop;
          setAway(distance > 160);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        role="log"
        aria-label={t("dchat.messages")}
      >
        <div ref={transcript} className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {canOlder && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void older()}
              className="mx-auto min-h-9 rounded-md px-3 text-xs text-ink-secondary hover:bg-raised-hover disabled:opacity-50"
            >
              {t("dchat.older")}
            </button>
          )}
          {messages.length === 0 && <p className="py-10 text-center text-sm text-ink-secondary">{t("dchat.empty")}</p>}
          {win.visible.map((m, i) => {
            const prev = i > 0 ? win.visible[i - 1] : undefined;
            const showDay = m.createdAt !== undefined && startsNewDay(prev?.createdAt, m.createdAt);
            return (
              <div key={m.id} className="flex flex-col gap-3">
                {showDay && <DaySeparator at={m.createdAt!} today={today} simple />}
                <Row message={m} />
              </div>
            );
          })}
          {activity.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {activity.map((m) => (
                <ToolRow key={m.id} message={m} />
              ))}
            </div>
          )}
          {working && (
            <div className="flex items-center gap-2 text-xs text-ink-secondary" role="status">
              <WorkingDots />
              <span>{t("dchat.working")}</span>
              <WorkingTimer since={since} />
            </div>
          )}
        </div>
      </div>
      {away && (
        <JumpToLatestButton
          className="bottom-3"
          onClick={() => {
            following.current = true;
            setStart(tailWindowStart(messages.length));
            toBottom();
          }}
        />
      )}
    </div>
  );
}
