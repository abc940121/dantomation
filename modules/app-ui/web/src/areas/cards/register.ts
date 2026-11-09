// The cards area: approval cards and questions in the thread, a bell, a settings page. Our own file (MIT).
// Core cards arrive by the event stream (card_pending / card_resolved). Module events (questions) do not
// reach that stream, so start() polls the questions route every 5 seconds while the page is visible.
import { registerArea } from "@/areas/registry";
import type { Action, State } from "@/store";
import { CardsInline } from "./CardsInline";
import { NotificationsBell, NotificationsPanel, NotificationSettings } from "./NotificationsBell";
import { loadRead, notify, saveRead } from "./prefs";
import { en, zhTw } from "./strings";
import type { CoreCard, NotifEvent, Question } from "./types";

export interface CardsState {
  cards: Record<string, CoreCard>;
  questions: Record<string, Question>;
  events: NotifEvent[];
  readIds: string[];
}

const EVENT_CAP = 200;
const initial: CardsState = { cards: {}, questions: {}, events: [], readIds: [] };

const cardEvent = (c: CoreCard): NotifEvent => ({ type: "card_pending", id: c.id, bot: c.bot, title: c.tool, body: c.summary, at: Date.parse(c.expiresAt) - 600000 || 0 });
const questionEvent = (q: Question): NotifEvent => ({ type: "question_pending", id: q.id, bot: q.bot, title: q.title, body: q.questions[0]?.prompt ?? "", at: q.createdAt });

function addEvents(list: NotifEvent[], add: NotifEvent[]): NotifEvent[] {
  const have = new Set(list.map((e) => e.id + e.type));
  const next = [...list];
  for (const e of add) if (!have.has(e.id + e.type)) next.push(e);
  return next.slice(-EVENT_CAP);
}

function reduce(s: CardsState, a: Action): CardsState {
  switch (a.type) {
    case "cards/init":
      return { ...s, readIds: a.readIds as string[] };
    case "cards/loaded": {
      const list = a.cards as CoreCard[];
      const cards = { ...s.cards };
      for (const c of list) cards[c.id] = c;
      return { ...s, cards, events: addEvents(s.events, list.filter((c) => c.state === "pending").map(cardEvent)) };
    }
    case "cards/pending": {
      const c = a.card as CoreCard;
      return { ...s, cards: { ...s.cards, [c.id]: c }, events: addEvents(s.events, [cardEvent(c)]) };
    }
    case "cards/resolved": {
      const c = s.cards[a.id as string];
      if (!c) return s;
      return { ...s, cards: { ...s.cards, [c.id]: { ...c, state: "resolved", decision: { answer: String(a.answer ?? "") } } } };
    }
    case "cards/questions": {
      const fetched = a.questions as Question[];
      const ids = new Set(fetched.map((q) => q.id));
      const questions: Record<string, Question> = {};
      for (const q of Object.values(s.questions)) if (q.state === "answered" || ids.has(q.id)) questions[q.id] = q;
      for (const q of fetched) if (questions[q.id]?.state !== "answered") questions[q.id] = q;
      return { ...s, questions, events: addEvents(s.events, fetched.filter((q) => q.state === "pending").map(questionEvent)) };
    }
    case "cards/question": {
      const q = a.question as Question;
      return { ...s, questions: { ...s.questions, [q.id]: q } };
    }
    case "cards/read": {
      const readIds = Array.from(new Set([...s.readIds, ...(a.ids as string[])]));
      saveRead(readIds);
      return { ...s, readIds };
    }
    default:
      return s;
  }
}

const botName = (s: State, id: string) => s.bots[id]?.name ?? id;

registerArea({
  id: "cards",
  strings: { en, "zh-tw": zhTw },
  slices: { cards: { initial, reduce } },
  events: {
    card_pending: (ev, api) => {
      const c = (ev.card ?? {}) as Partial<CoreCard>;
      if (typeof c.id !== "string") return [];
      const card: CoreCard = { id: c.id, task: c.task ?? "", bot: c.bot ?? "", tool: c.tool ?? "tool", summary: c.summary ?? "", expiresAt: c.expiresAt ?? "", state: "pending", decision: null };
      notify(api.t("cards.notify.approval", { bot: botName(api.getState(), card.bot) }), `${card.tool}: ${card.summary}`.slice(0, 200), card.id);
      return [{ type: "cards/pending", card }];
    },
    card_resolved: (ev) => (typeof ev.cardId === "string" ? [{ type: "cards/resolved", id: ev.cardId, answer: ev.answer }] : []),
    question_pending: (ev) => (ev.question ? [{ type: "cards/question", question: ev.question }] : []),
    question_resolved: () => [], // the 5 second poll picks the change up
  },
  views: [
    { slot: "thread-inline", id: "cards", component: CardsInline },
    { slot: "header-action", id: "notifications", component: NotificationsBell },
    { slot: "overlay", id: "notifications", component: NotificationsPanel },
    { slot: "settings-page", id: "notifications", component: NotificationSettings },
  ],
  start(api) {
    api.dispatch({ type: "cards/init", readIds: loadRead() });
    const known = new Set<string>();
    let first = true;
    const loadCards = async () => {
      try {
        const r = await api.client.get<CoreCard[] | { cards: CoreCard[] }>("/api/cards");
        const cards = Array.isArray(r) ? r : (r.cards ?? []);
        api.dispatch({ type: "cards/loaded", cards });
      } catch {
        /* offline or not paired yet; the next poll tries again */
      }
    };
    const loadQuestions = async () => {
      try {
        const r = await api.client.get<{ questions: Question[] }>("/m/app-ui/api/questions?state=pending");
        const list = r.questions ?? [];
        for (const q of list) {
          if (!known.has(q.id) && !first) notify(api.t("cards.notify.question", { bot: botName(api.getState(), q.bot) }), q.title, q.id);
          known.add(q.id);
        }
        first = false;
        api.dispatch({ type: "cards/questions", questions: list });
      } catch {
        /* same */
      }
    };
    void loadCards();
    void loadQuestions();
    const timer = setInterval(() => {
      if (!document.hidden) void loadQuestions();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) {
        void loadCards();
        void loadQuestions();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },
});
