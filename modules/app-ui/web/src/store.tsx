// The app store. Our own file (MIT). An external store in React context, read with
// useSyncExternalStore. Core state:
//   bots          WireBot by id, botOrder the display order
//   messages      per bot, WireMessage[] with a stable id each (a replayed frame replaces its row)
//   activity      per bot, the tool lines of the running turn (cleared when the turn completes)
//   connection    'connecting' | 'live' | 'offline'
//   ui            {view, selectedBotId, overlays}
//   slices        state of the area slices, by slice name
// Area slice reducers see every action, the core ones too.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ServerFrame, WireBot, WireMessage } from "@shared/wire";
import { AreaContext, getAreas, type AreaApi } from "@/areas/registry";
import { client as defaultClient, type Client } from "@/dantomation/client";
import { startLive } from "@/dantomation/live";
import { t } from "@/lib/i18n";

export type Connection = "connecting" | "live" | "offline";
export interface Overlay {
  id: string;
  props: Record<string, unknown>;
}
export interface UiState {
  view: string;
  selectedBotId: string | null;
  overlays: Overlay[];
}
export interface State {
  loaded: boolean;
  bots: Record<string, WireBot>;
  botOrder: string[];
  messages: Record<string, WireMessage[]>;
  activity: Record<string, WireMessage[]>;
  connection: Connection;
  ui: UiState;
  slices: Record<string, unknown>;
}

export interface SnapshotPayload {
  bots: WireBot[];
  messages?: Record<string, WireMessage[]>;
}

/** Core actions. Areas add their own (any {type: "<area>.<thing>", ...}). */
export type Action =
  | { type: "snapshot"; snapshot: SnapshotPayload }
  | { type: "frame"; frame: ServerFrame }
  | { type: "select"; botId: string | null }
  | { type: "connection"; state: Connection }
  | { type: "navigate"; view: string }
  | { type: "overlay.open"; id: string; props?: Record<string, unknown> }
  | { type: "overlay.close"; id: string }
  | { type: "history"; botId: string; messages: WireMessage[] }
  | { type: "message.local"; botId: string; message: WireMessage }
  | { type: string; [key: string]: unknown };

export const MESSAGE_CAP = 500;
const botOf = (threadId: string) => (threadId.startsWith("main:") ? threadId.slice(5) : threadId);

/** Every registered slice at its `initial` value, so selectors never see an undefined slice before the first dispatch. */
function seedSlices(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const area of getAreas()) {
    for (const [name, def] of Object.entries(area.slices ?? {})) out[name] = (def as { initial: unknown }).initial;
  }
  return out;
}

export function initialState(): State {
  return {
    loaded: false,
    bots: {},
    botOrder: [],
    messages: {},
    activity: {},
    connection: "connecting",
    ui: { view: "bot", selectedBotId: null, overlays: [] },
    slices: seedSlices(),
  };
}

function upsert(list: WireMessage[] | undefined, message: WireMessage): WireMessage[] {
  const rows = list ?? [];
  const i = rows.findIndex((m) => m.id === message.id);
  if (i >= 0) {
    const next = rows.slice();
    next[i] = { ...rows[i], ...message };
    return next;
  }
  const next = [...rows, message];
  return next.length > MESSAGE_CAP ? next.slice(next.length - MESSAGE_CAP) : next;
}

function withBot(s: State, bot: WireBot): State {
  const known = s.bots[bot.id];
  const merged: WireBot = bot.partial && known ? { ...known, status: bot.status } : { ...known, ...bot, partial: undefined };
  if (bot.partial && !known) return s; // a status for a bot the snapshot does not list
  return { ...s, bots: { ...s.bots, [bot.id]: merged }, botOrder: s.botOrder.includes(bot.id) ? s.botOrder : [...s.botOrder, bot.id] };
}

function applyFrame(s: State, f: ServerFrame): State {
  switch (f.kind) {
    case "message":
    case "message.patch": {
      const id = botOf(f.threadId);
      return { ...s, messages: { ...s.messages, [id]: upsert(s.messages[id], f.message) } };
    }
    case "activity":
      return { ...s, activity: { ...s.activity, [f.botId]: upsert(s.activity[f.botId], f.message) } };
    case "bot":
      return withBot(s, f.bot);
    case "bot.deleted": {
      const { [f.botId]: _gone, ...bots } = s.bots;
      void _gone;
      return { ...s, bots, botOrder: s.botOrder.filter((b) => b !== f.botId), ui: s.ui.selectedBotId === f.botId ? { ...s.ui, selectedBotId: null } : s.ui };
    }
    case "runtime": {
      const ev = f.event as { type?: string; threadId?: string };
      if (ev.type === "turn.completed" && ev.threadId) {
        const id = botOf(ev.threadId);
        if (s.activity[id]?.length) return { ...s, activity: { ...s.activity, [id]: [] } };
      }
      return s;
    }
    default:
      return s; // hello, ping, sections, thread, group: nothing in the foundation
  }
}

function core(s: State, a: Action): State {
  switch (a.type) {
    case "snapshot": {
      const snap = (a as { snapshot: SnapshotPayload }).snapshot;
      const bots: Record<string, WireBot> = {};
      const order: string[] = [];
      for (const b of snap.bots ?? []) {
        if (b.hidden) continue;
        bots[b.id] = b;
        order.push(b.id);
      }
      const messages: Record<string, WireMessage[]> = { ...s.messages };
      for (const [id, rows] of Object.entries(snap.messages ?? {})) {
        // keep rows the stream added that the snapshot does not have yet
        const seen = new Set(rows.map((m) => m.id));
        messages[id] = [...rows, ...(s.messages[id] ?? []).filter((m) => !seen.has(m.id))];
      }
      const selected = s.ui.selectedBotId && bots[s.ui.selectedBotId] ? s.ui.selectedBotId : (order[0] ?? null);
      return { ...s, loaded: true, bots, botOrder: order, messages, ui: { ...s.ui, selectedBotId: selected } };
    }
    case "frame":
      return applyFrame(s, (a as { frame: ServerFrame }).frame);
    case "select":
      return { ...s, ui: { ...s.ui, selectedBotId: (a as { botId: string | null }).botId, view: "bot" } };
    case "connection":
      return { ...s, connection: (a as { state: Connection }).state };
    case "navigate":
      return { ...s, ui: { ...s.ui, view: (a as { view: string }).view } };
    case "overlay.open": {
      const { id, props } = a as { id: string; props?: Record<string, unknown> };
      return { ...s, ui: { ...s.ui, overlays: [...s.ui.overlays.filter((o) => o.id !== id), { id, props: props ?? {} }] } };
    }
    case "overlay.close":
      return { ...s, ui: { ...s.ui, overlays: s.ui.overlays.filter((o) => o.id !== (a as { id: string }).id) } };
    case "history": {
      const { botId, messages } = a as { botId: string; messages: WireMessage[] };
      const have = s.messages[botId] ?? [];
      const seen = new Set(have.map((m) => m.id));
      return { ...s, messages: { ...s.messages, [botId]: [...messages.filter((m) => !seen.has(m.id)), ...have] } };
    }
    case "message.local": {
      const { botId, message } = a as { botId: string; message: WireMessage };
      return { ...s, messages: { ...s.messages, [botId]: upsert(s.messages[botId], message) } };
    }
    default:
      return s;
  }
}

/** The core reducer, then every area slice reducer. Exported for tests. */
export function reduce(s: State, a: Action): State {
  let next = core(s, a);
  let slices = next.slices;
  for (const area of getAreas()) {
    for (const [name, def] of Object.entries(area.slices ?? {})) {
      const cur = name in slices ? slices[name] : def.initial;
      const upd = (def as { reduce: (c: unknown, a: Action, s: State) => unknown }).reduce(cur, a, next);
      if (upd !== cur || !(name in slices)) {
        if (slices === next.slices) slices = { ...slices };
        slices[name] = upd;
      }
    }
  }
  if (slices !== next.slices) next = { ...next, slices };
  return next;
}

export interface Store {
  getState: () => State;
  dispatch: (action: Action) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createStore(): Store {
  let state = initialState();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

const StoreContext = createContext<Store | null>(null);

export function useStoreInstance(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("store: no StoreProvider");
  return s;
}

/** Reads a piece of state. The selector must return a stable value (state fields, not fresh objects). */
export function useSelector<T>(selector: (state: State) => T): T {
  const store = useStoreInstance();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function makeAreaApi(store: Store, client: Client): AreaApi {
  return {
    client,
    dispatch: store.dispatch,
    getState: store.getState,
    useStore: useSelector,
    t,
    navigate: (view) => store.dispatch({ type: "navigate", view }),
    openOverlay: (id, props) => store.dispatch({ type: "overlay.open", id, props }),
    closeOverlay: (id) => store.dispatch({ type: "overlay.close", id }),
  };
}

/** Provides the store and the area api. Call <Boot/> inside it once the gates let the app through. */
export function StoreProvider({ children, client = defaultClient }: { children: ReactNode; client?: Client }) {
  const store = useMemo(() => createStore(), []);
  const api = useMemo(() => makeAreaApi(store, client), [store, client]);
  return (
    <StoreContext.Provider value={store}>
      <AreaContext.Provider value={api}>{children}</AreaContext.Provider>
    </StoreContext.Provider>
  );
}

/** Loads the snapshot, opens the live stream and starts the areas. Unmount stops all three. */
export function Boot() {
  const store = useStoreInstance();
  const api = useContext(AreaContext)!;
  const started = useRef(false);
  const load = useCallback(async () => {
    const snap = await api.client.get<SnapshotPayload>("/m/app-ui/api/snapshot");
    store.dispatch({ type: "snapshot", snapshot: snap });
  }, [api, store]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let stopLive = () => {};
    const cleanups: Array<() => void> = [];
    let off = false;
    void load()
      .catch(() => undefined) // the stream's replay and the next snapshot fill in
      .then(() => {
        if (off) return;
        stopLive = startLive({ client: api.client, api, dispatch: store.dispatch });
      });
    for (const area of getAreas()) {
      try {
        const c = area.start?.(api);
        if (typeof c === "function") cleanups.push(c);
      } catch {
        /* one area failing to start must not stop the app */
      }
    }
    return () => {
      off = true;
      started.current = false;
      stopLive();
      for (const c of cleanups) c();
    };
  }, [api, load, store]);
  return null;
}
