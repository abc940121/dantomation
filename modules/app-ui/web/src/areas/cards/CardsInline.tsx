// Cards in the bot thread: approvals (Allow / Deny) and questions (choices and free text). Our own file (MIT).
import { useState } from "react";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { coreCardToOptionCard, questionToCard, respondToRequest } from "../../../../adapter/areas/cards-map.mjs";
import type { CardsState } from "./register";
import type { Question } from "./types";

const btn = "inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 ring-focus disabled:opacity-50";

function useSend() {
  const { client, t } = useArea();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(call: { method: string; path: string; body: unknown }, after: () => void): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await client.post(call.path, call.body);
      after();
    } catch (e) {
      setError(t("cards.error.generic", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }
  return { send, busy, error };
}

function Shell({ title, subtitle, children, tone }: { title: string; subtitle?: string; children: React.ReactNode; tone?: "warn" }) {
  return (
    <section className={cn("rounded-xl border bg-card p-3 text-sm", tone === "warn" ? "border-warning" : "border-hairline")}>
      <h3 className="font-medium text-ink">{title}</h3>
      {subtitle ? <p className="mt-1 whitespace-pre-wrap break-words text-ink-secondary">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ApprovalCard({ id }: { id: string }) {
  const { useStore, t, dispatch } = useArea();
  const raw = useStore((s) => (s.slices.cards as CardsState).cards[id]);
  const { send, busy, error } = useSend();
  if (!raw) return null;
  const card = coreCardToOptionCard(raw, Date.now());
  const decide = (behavior: "allow" | "deny") =>
    send(respondToRequest(card.threadId, { requestId: card.requestId, behavior }), () => dispatch({ type: "cards/resolved", id, answer: behavior === "allow" ? "yes" : "no" }));
  const settled = card.state !== "pending";
  const label =
    card.state === "expired"
      ? t("cards.approval.expired")
      : card.answered === "yes"
        ? t("cards.approval.allowed")
        : card.answered === "no"
          ? t("cards.approval.denied")
          : t("cards.approval.answered", { answer: card.answered ?? "" });
  return (
    <Shell title={`${t("cards.approval.title")}: ${card.title}`} subtitle={card.subtitle} tone={settled ? undefined : "warn"}>
      {settled ? (
        <p className="text-ink-tertiary">{label}</p>
      ) : (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void decide("allow")} className={cn(btn, "bg-accent text-accent-text")}>
            {t("cards.approval.allow")}
          </button>
          <button type="button" disabled={busy} onClick={() => void decide("deny")} className={cn(btn, "bg-control text-ink")}>
            {t("cards.approval.deny")}
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}

function QuestionCard({ id }: { id: string }) {
  const { useStore, t, dispatch } = useArea();
  const raw = useStore((s) => (s.slices.cards as CardsState).questions[id]);
  const { send, busy, error } = useSend();
  const [picked, setPicked] = useState<number[][]>([]);
  const [texts, setTexts] = useState<string[]>([]);
  if (!raw) return null;
  const card = questionToCard(raw, Date.now());
  const settled = card.state !== "pending";
  const toggle = (qi: number, oi: number, multi: boolean) =>
    setPicked((p) => {
      const next = p.slice();
      const cur = next[qi] ?? [];
      next[qi] = multi ? (cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi]) : [oi];
      return next;
    });
  const answers = raw.questions.map((_, i) => {
    const text = (texts[i] ?? "").trim();
    return { selected: picked[i] ?? [], ...(text ? { text } : {}) };
  });
  const ready = answers.every((a) => a.selected.length > 0 || "text" in a);
  const submit = () => {
    const call = respondToRequest(card.threadId, { requestId: card.requestId, behavior: "answer", message: { answers } });
    return send(call, () => dispatch({ type: "cards/question", question: { ...raw, state: "answered", answers } satisfies Question }));
  };
  return (
    <Shell title={card.title} tone={settled ? undefined : "warn"}>
      <div className="space-y-4">
        {raw.questions.map((q, qi) => (
          <fieldset key={qi} disabled={settled || busy} className="min-w-0">
            <legend className="mb-2 whitespace-pre-wrap break-words text-ink">{q.prompt}</legend>
            <div className="flex flex-col gap-2">
              {q.options.map((o, oi) => {
                const on = settled ? (raw.answers?.[qi]?.selected ?? []).includes(oi) : (picked[qi] ?? []).includes(oi);
                return (
                  <button
                    key={oi}
                    type="button"
                    role={q.multi ? "checkbox" : "radio"}
                    aria-checked={on}
                    onClick={() => toggle(qi, oi, !!q.multi)}
                    className={cn("rounded-lg border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 ring-focus", on ? "border-accent bg-raised" : "border-hairline bg-inset")}
                  >
                    <span className="block text-ink">{o.label}</span>
                    {o.description ? <span className="block text-xs text-ink-secondary">{o.description}</span> : null}
                  </button>
                );
              })}
              {q.allowText ? (
                <input
                  type="text"
                  value={settled ? (raw.answers?.[qi]?.text ?? "") : (texts[qi] ?? "")}
                  placeholder={t("cards.question.textPlaceholder")}
                  onChange={(e) =>
                    setTexts((x) => {
                      const n = x.slice();
                      n[qi] = e.target.value;
                      return n;
                    })
                  }
                  className="min-h-10 rounded-lg border border-hairline bg-inset px-3 text-ink focus-visible:outline-none focus-visible:ring-2 ring-focus"
                />
              ) : null}
            </div>
          </fieldset>
        ))}
      </div>
      {settled ? (
        <p className="mt-3 text-ink-tertiary">{card.state === "expired" ? t("cards.question.expired") : t("cards.question.answered")}</p>
      ) : (
        <button type="button" disabled={busy || !ready} onClick={() => void submit()} className={cn(btn, "mt-3 bg-accent text-accent-text")}>
          {t("cards.question.submit")}
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}

/** The thread-inline view: this bot's open cards, plus ones answered or expired this session. */
export function CardsInline({ botId }: { botId: string }) {
  const { useStore } = useArea();
  const st = useStore((s) => s.slices.cards as CardsState);
  const cards = Object.values(st.cards).filter((c) => c.bot === botId);
  const questions = Object.values(st.questions).filter((q) => q.bot === botId);
  if (!cards.length && !questions.length) return null;
  return (
    <div className="mx-auto flex max-h-[45dvh] w-full max-w-3xl flex-col gap-2 overflow-y-auto px-4 py-2">
      {cards.map((c) => (
        <ApprovalCard key={c.id} id={c.id} />
      ))}
      {questions.map((q) => (
        <QuestionCard key={q.id} id={q.id} />
      ))}
    </div>
  );
}
