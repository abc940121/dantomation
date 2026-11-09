// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import { useEffect, useMemo, useRef, useState } from "react";
import type { WireMessage } from "@shared/wire";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { Avatar, hashHue } from "@/shell/Avatar";
import { routeHint, roomRouteForComposer } from "../lib/group-routing";
import { mentionChoicesForQuery, mentionQueryAt, type MentionPeer } from "../lib/mentions";
import { showsSpeaker, speakerOf } from "../lib/room-speaker";
import { kickRooms } from "../state";
import type { RoomInfo, RoomStatus } from "../types";
import { EVERYONE_ID, MentionMenu, type MentionChoice } from "./MentionMenu";
import { MentionText } from "./MentionText";
import { MentionTextarea } from "./MentionTextarea";
import { RoomQueueList } from "./RoomQueueList";
import { TurnPresence } from "./TurnPresence";

const colorOf = (id: string) => `hsl(${hashHue(id)} 45% 55%)`;

function timeOf(at: number | undefined): string {
  if (at === undefined) return "";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function RoomMessage({ message, show, peers }: { message: WireMessage; show: boolean; peers: MentionPeer[] }) {
  const { t } = useArea();
  const extra = (message.extra ?? {}) as { label?: string; lineKind?: string };
  if (extra.lineKind === "system") {
    return <li className="px-4 py-1 text-center text-xs text-ink-tertiary" data-testid="room-system">{message.text}</li>;
  }
  const mine = message.role === "user";
  const speaker = speakerOf(message);
  const name = mine ? t("rooms.you") : extra.label || speaker;
  return (
    <li className={cn("flex gap-2 px-3", mine ? "flex-row-reverse" : "", show ? "mt-3" : "mt-0.5")} data-testid="room-message" data-speaker={speaker}>
      <span className="w-8 shrink-0">{show && !mine ? <Avatar id={speaker || name} name={name} size={32} /> : null}</span>
      <div className={cn("flex min-w-0 max-w-[85%] flex-col", mine ? "items-end" : "items-start")}>
        {show ? (
          <span className="mb-0.5 flex items-baseline gap-2 px-1 text-xs text-ink-secondary" data-testid="room-speaker">
            <span className="font-medium">{name}</span>
            <span className="text-ink-tertiary">{timeOf(message.createdAt)}</span>
          </span>
        ) : null}
        <div className={cn("rounded-2xl px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap", mine ? "bg-accent text-accent-text" : "bg-card text-ink")}>
          <MentionText text={message.text ?? ""} peers={peers} everyone />
        </div>
      </div>
    </li>
  );
}

function RoomComposer({ room, onSent }: { room: RoomInfo; onSent: () => void }) {
  const { client, t } = useArea();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const peers = useMemo<MentionPeer[]>(() => room.members.map((m) => ({ name: m.name, color: colorOf(m.id) })), [room.members]);
  const query = useMemo(() => mentionQueryAt(text, caret), [text, caret]);
  const pool = useMemo<MentionChoice[]>(
    () => [{ id: EVERYONE_ID, name: "everyone", everyone: true }, ...room.members.map((m): MentionChoice => ({ id: m.id, name: m.name, member: true }))],
    [room.members],
  );
  const choices = useMemo(() => (query && !dismissed ? mentionChoicesForQuery(pool, query.query) : []), [pool, query, dismissed]);
  const open = choices.length > 0;
  const hint = useMemo(() => routeHint(roomRouteForComposer(text, room), t), [text, room, t]);

  useEffect(() => setHighlight(0), [query?.query, query?.start]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-mention-index="${highlight}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);

  function pick(choice: MentionChoice) {
    if (!query) return;
    const input = ref.current;
    const end = input ? input.selectionStart : caret;
    const insert = `@${choice.name} `;
    const next = text.slice(0, query.start) + insert + text.slice(end);
    const at = query.start + insert.length;
    setText(next);
    setCaret(at);
    setDismissed(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(at, at);
    });
  }

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.post(`/m/rooms/rooms/${encodeURIComponent(room.id)}/say`, { text: body });
      setText("");
      setCaret(0);
      onSent();
    } catch (e) {
      setError(t("rooms.sendFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-3 pt-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <div className="mx-auto w-full max-w-3xl">
        {error ? <p role="alert" className="mb-1 text-xs text-danger">{error}</p> : null}
        <p className="mb-1 truncate px-1 text-xs text-ink-tertiary" data-testid="room-hint">{hint}</p>
        <form
          className="relative flex items-end gap-2 rounded-2xl bg-composer p-2 ring-1 ring-composer-ring"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {open ? (
            <MentionMenu listRef={listRef} choices={choices} highlight={highlight} everyoneCount={room.members.length} onPick={pick} onHighlight={setHighlight} />
          ) : null}
          <MentionTextarea
            inputRef={ref}
            peers={peers}
            everyone
            value={text}
            rows={1}
            wrapperClassName="px-2"
            placeholder={t("rooms.placeholder", { name: room.name })}
            aria-label={t("rooms.placeholder", { name: room.name })}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-activedescendant={open ? `rooms-mention-${choices[highlight]?.id}` : undefined}
            className="max-h-40 min-h-10 w-full resize-none bg-transparent py-2 text-base text-ink outline-none placeholder:text-ink-tertiary"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissed(false);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (open) {
                if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % choices.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + choices.length) % choices.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const c = choices[highlight]; if (c) pick(c); return; }
                if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="min-h-10 shrink-0 rounded-xl bg-accent px-4 text-sm font-medium text-accent-text disabled:opacity-40"
          >
            {t("rooms.send")}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The group page body: transcript with speaker labels, turn presence and queue, then the composer. */
export function GroupView({ room, messages, status, error }: { room: RoomInfo; messages: WireMessage[]; status: RoomStatus; error: string | null }) {
  const { t } = useArea();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const peers = useMemo<MentionPeer[]>(() => room.members.map((m) => ({ name: m.name, color: colorOf(m.id) })), [room.members]);

  const since = useRef<{ speaker: string | null; at: number }>({ speaker: null, at: Date.now() });
  if (since.current.speaker !== status.speaker) since.current = { speaker: status.speaker, at: Date.now() };
  const speaker = room.members.find((m) => m.id === status.speaker);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, status.busy, status.queue.length]);

  return (
    <>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <ul className="mx-auto flex w-full max-w-3xl flex-col" aria-live="polite">
          {messages.length === 0 && !error ? <li className="px-4 py-6 text-center text-sm text-ink-secondary">{t("rooms.noMessages")}</li> : null}
          {messages.map((m, i) => (
            <RoomMessage key={m.id} message={m} show={showsSpeaker(messages, i)} peers={peers} />
          ))}
        </ul>
        {error ? <p role="alert" className="mx-auto mt-2 max-w-3xl px-4 text-xs text-danger">{t("rooms.loadFailed", { error })}</p> : null}
        <div className="mx-auto mt-2 flex w-full max-w-3xl flex-col gap-1 px-3">
          <TurnPresence
            visible={status.busy}
            label={speaker ? t("rooms.working", { name: speaker.name }) : t("rooms.workingLead")}
            since={speaker ? since.current.at : null}
            avatar={speaker ? <Avatar id={speaker.id} name={speaker.name} size={24} /> : null}
          />
          <RoomQueueList room={room} status={status} />
        </div>
      </div>
      <RoomComposer room={room} onSent={kickRooms} />
    </>
  );
}
