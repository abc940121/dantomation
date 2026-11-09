// The foundation 'composer' view: a textarea and a send button. Our own file (MIT).
// Enter sends, Shift+Enter breaks the line, Enter during IME composition does nothing.
// An area (voice, attachments) replaces it with a higher-priority 'composer' view.
import { useState } from "react";
import type { WireMessage } from "@shared/wire";
import { useArea } from "@/areas/registry";

export function BasicComposer({ botId }: { botId: string }) {
  const { client, dispatch, useStore, t } = useArea();
  const name = useStore((s) => s.bots[botId]?.name) ?? botId;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await client.post<{ message: WireMessage }>(`/m/app-ui/api/bots/${encodeURIComponent(botId)}/messages`, { text: body });
      dispatch({ type: "message.local", botId, message: r.message });
      setText("");
    } catch (e) {
      setError(t("app.composer.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

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
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t("app.composer.placeholder", { name })}
            aria-label={t("app.composer.placeholder", { name })}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base text-ink outline-none placeholder:text-ink-tertiary"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="min-h-10 shrink-0 rounded-xl bg-accent px-4 text-sm font-medium text-accent-text disabled:opacity-40"
          >
            {t("app.composer.send")}
          </button>
        </form>
      </div>
    </div>
  );
}
