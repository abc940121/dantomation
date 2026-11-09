// The chat composer: a growing textarea with a per-bot draft, a send button and, while the bot works, a stop button.
// Our own file (MIT). Enter sends, Shift+Enter breaks the line, Enter during IME composition does nothing.
import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import type { WireMessage } from "@shared/wire";
import { useArea } from "@/areas/registry";
import { readDraft, writeDraft } from "./lib/drafts";
import { latestTaskId } from "./lib/task-id";

const EMPTY: WireMessage[] = [];

export function ChatComposer({ botId }: { botId: string }) {
  const { client, dispatch, useStore, t } = useArea();
  const name = useStore((s) => s.bots[botId]?.name) ?? botId;
  const working = useStore((s) => s.bots[botId]?.status === "busy");
  const messages = useStore((s) => s.messages[botId]) ?? EMPTY;
  const [text, setText] = useState(() => readDraft(botId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const current = useRef(botId);

  // Switching bots swaps the draft: the old one was saved on each keystroke.
  useEffect(() => {
    current.current = botId;
    setText(readDraft(botId));
    setError("");
  }, [botId]);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  function edit(value: string) {
    setText(value);
    writeDraft(botId, value);
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    const target = botId;
    setSending(true);
    setError("");
    try {
      const r = await client.post<{ message: WireMessage }>(`/m/app-ui/api/bots/${encodeURIComponent(target)}/messages`, { text: body });
      dispatch({ type: "message.local", botId: target, message: r.message });
      writeDraft(target, "");
      if (current.current === target) setText("");
    } catch (e) {
      setError(t("dchat.sendFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    const task = latestTaskId(messages);
    if (!task) return;
    setError("");
    try {
      await client.post(`/api/tasks/${encodeURIComponent(task)}/stop`, {});
    } catch (e) {
      setError(t("dchat.stopFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  const label = t("dchat.placeholder", { name });
  return (
    <div className="px-3 pt-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <div className="mx-auto w-full max-w-3xl">
        {error && (
          <p role="alert" className="mb-1 text-xs text-danger">
            {error}
          </p>
        )}
        <form
          className="flex items-end gap-2 rounded-2xl bg-composer p-2 ring-1 ring-composer-ring"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={field}
            value={text}
            rows={1}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={label}
            aria-label={label}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base text-ink outline-none placeholder:text-ink-tertiary"
          />
          {working && (
            <button
              type="button"
              onClick={() => void stop()}
              aria-label={t("dchat.stop")}
              title={t("dchat.stop")}
              className="flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-xl bg-raised text-ink hover:bg-raised-hover"
            >
              <Square size={16} aria-hidden="true" />
            </button>
          )}
          <button
            type="submit"
            disabled={sending || !text.trim()}
            className="min-h-10 shrink-0 rounded-xl bg-accent px-4 text-sm font-medium text-accent-text disabled:opacity-40"
          >
            {t("dchat.send")}
          </button>
        </form>
      </div>
    </div>
  );
}
