// The area registry. Our own file (MIT).
//
// An area is a package of features (markdown, rooms, cards, voice, settings) that lives in
// src/areas/<name>/ and plugs in by calling registerArea() from src/areas/<name>/register.ts.
// src/areas/index.ts loads every register.ts, so adding an area never touches a foundation file.
//
// Slots
//   single-winner (the view with the highest priority for an id wins; foundation defaults are 0):
//     'thread'     {botId}   the message list of one bot
//     'composer'   {botId}   the input under it
//     'main-view'  {}        a whole page; id is matched against ui.view ('bot' is the foundation's)
//   ordered (all views show; sorted by priority ascending, then by registration order):
//     'sidebar-section' {}         a block under the bot list
//     'thread-inline'   {botId}    a block between the thread and the composer
//     'header-action'   {}         a button in the header
//     'settings-page'   {}         a page of the settings area
//     'overlay'         {id, ...props, close}   opened with openOverlay(id, props)
//     'gate'            {}         called as a function by the host; returning non-null shows it
//                                  instead of the app (the pairing screen is one)
import { createContext, useContext, type ComponentType } from "react";
import type { Client } from "@/dantomation/client";
import { registerStrings } from "@/lib/i18n";
import type { Action, State } from "@/store";

export type SingleSlot = "thread" | "composer" | "main-view";
export type MultiSlot = "sidebar-section" | "thread-inline" | "header-action" | "settings-page" | "overlay" | "gate";
export type Slot = SingleSlot | MultiSlot;
export const SINGLE_SLOTS: readonly SingleSlot[] = ["thread", "composer", "main-view"];

export interface AreaView {
  slot: Slot;
  id: string;
  priority?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
}

export interface AreaApi {
  client: Client;
  dispatch: (action: Action) => void;
  getState: () => State;
  useStore: <T>(selector: (state: State) => T) => T;
  t: (key: string, params?: Record<string, string | number>) => string;
  navigate: (view: string) => void;
  openOverlay: (id: string, props?: Record<string, unknown>) => void;
  closeOverlay: (id: string) => void;
}

export interface SliceDef<S = unknown> {
  initial: S;
  /** Gets every action (core ones too, e.g. {type:"frame"}), returns the next slice state. */
  reduce: (slice: S, action: Action, state: State) => S;
}

export interface AreaDef {
  id: string;
  /** New UI strings by pack: "en" and "zh-tw". Keys should start with the area id. */
  strings?: { en?: Record<string, string>; "zh-tw"?: Record<string, string> };
  slices?: Record<string, SliceDef<never> | SliceDef<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Core event type (the SSE event name, e.g. "card_pending") -> actions to dispatch. */
  events?: Record<string, (ev: Record<string, unknown>, api: AreaApi) => Action[]>;
  views?: AreaView[];
  /** Runs once when the app starts (after the first render); the returned function cleans up. */
  start?: (api: AreaApi) => void | (() => void);
}

const areas: AreaDef[] = [];
const listeners = new Set<() => void>();

export function registerArea(def: AreaDef): void {
  if (!def || typeof def.id !== "string" || !def.id) throw new Error("registerArea: id is required");
  if (areas.some((a) => a.id === def.id)) throw new Error(`registerArea: area "${def.id}" is already registered`);
  areas.push(def);
  if (def.strings) registerStrings(def.strings as Record<string, Record<string, string>>);
  for (const fn of listeners) fn();
}

export function getAreas(): readonly AreaDef[] {
  return areas;
}

/** For tests: forget every registered area. */
export function resetAreas(): void {
  areas.length = 0;
}

interface Ranked extends AreaView {
  order: number;
}

function ranked(slot: Slot): Ranked[] {
  const out: Ranked[] = [];
  let order = 0;
  for (const a of areas) for (const v of a.views ?? []) out.push({ ...v, order: order++ });
  return out.filter((v) => v.slot === slot);
}

/** The winning view for one id of a single-winner slot (highest priority; the later registration wins a tie). */
export function pickView(slot: SingleSlot, id: string): AreaView | undefined {
  let best: Ranked | undefined;
  for (const v of ranked(slot)) {
    if (v.id !== id) continue;
    if (!best || (v.priority ?? 0) > (best.priority ?? 0) || ((v.priority ?? 0) === (best.priority ?? 0) && v.order > best.order)) best = v;
  }
  return best;
}

/** The winner of 'thread' or 'composer': the highest priority view in the slot, whatever its id (the later registration wins a tie). */
export function pickSlot(slot: "thread" | "composer"): AreaView | undefined {
  let best: Ranked | undefined;
  for (const v of ranked(slot)) {
    if (!best || (v.priority ?? 0) > (best.priority ?? 0) || ((v.priority ?? 0) === (best.priority ?? 0) && v.order > best.order)) best = v;
  }
  return best;
}

/** Every view of an ordered slot, sorted by priority ascending, then registration order. */
export function listViews(slot: MultiSlot): AreaView[] {
  return ranked(slot).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.order - b.order);
}

export function subscribeAreas(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const AreaContext = createContext<AreaApi | null>(null);

/** The api for area components: client, dispatch, getState, useStore(selector), t, navigate, openOverlay, closeOverlay. */
export function useArea(): AreaApi {
  const api = useContext(AreaContext);
  if (!api) throw new Error("useArea: no AreaContext (render inside <App>)");
  return api;
}
