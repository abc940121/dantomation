// The live event stream. Our own file (MIT). Fetches /api/events (SSE) with the Bearer header,
// parses the named events (a port of the parser in modules/chat-ui), turns each core event into
// frames with adapter/frames.mjs, and gives area event mappers a turn.
//
// Frames the app sees besides the real ones: {kind:"hello", cursor, resumed} after each connect and
// {kind:"ping"} for each ": ping" comment. A stream with no bytes for 40s is dropped and
// reconnected with a backoff of up to 15s, resuming from the last seq.
import { translate } from "../../../adapter/frames.mjs";
import type { ServerFrame } from "@shared/wire";
import { getAreas, type AreaApi } from "@/areas/registry";
import type { Action } from "@/store";
import { ApiError, type Client } from "./client";

export const STALE_MS = 40_000;
export const MAX_BACKOFF_MS = 15_000;

/** Parses SSE text into (eventName, parsedJson) calls. Comments and blocks without data are skipped. */
export function createSSEParser(onEvent: (type: string, data: Record<string, unknown>) => void) {
  let buf = "";
  let hold = "";
  return {
    push(chunk: string): void {
      let text = hold + chunk;
      hold = "";
      if (text.endsWith("\r")) {
        hold = "\r";
        text = text.slice(0, -1);
      }
      buf += text.replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let type = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line[0] === ":") continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          let value = c < 0 ? "" : line.slice(c + 1);
          if (value[0] === " ") value = value.slice(1);
          if (field === "event") type = value;
          else if (field === "data") data.push(value);
        }
        if (!data.length) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }
        if (parsed && typeof parsed === "object") onEvent(type, parsed as Record<string, unknown>);
      }
    },
  };
}

export interface LiveOptions {
  client: Client;
  api: AreaApi;
  dispatch: (action: Action) => void;
  /** Resume point; 0 replays what the server still holds. */
  since?: number;
}

export function startLive(opts: LiveOptions): () => void {
  const { client, api, dispatch } = opts;
  let stopped = false;
  let lastSeq = opts.since ?? 0;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let wake: (() => void) | null = null;
  const tstate = { replies: {}, taskBot: {} };

  const frame = (f: ServerFrame) => dispatch({ type: "frame", frame: f });

  function onEvent(type: string, data: Record<string, unknown>): void {
    if (typeof data.seq === "number" && data.seq > lastSeq) lastSeq = data.seq;
    const ev = { ...data, type };
    for (const f of translate(ev, tstate) as unknown as ServerFrame[]) frame(f);
    for (const area of getAreas()) {
      const map = area.events?.[type];
      if (!map) continue;
      try {
        for (const action of map(ev, api)) dispatch(action);
      } catch {
        /* a broken area mapper must not stop the stream */
      }
    }
  }

  async function once(): Promise<void> {
    const mine = new AbortController();
    ctrl = mine;
    let stale: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(stale);
      stale = setTimeout(() => mine.abort(), STALE_MS);
    };
    try {
      arm();
      const res = await client.stream(`/api/events?since=${lastSeq}`, { signal: mine.signal });
      if (!res.body) throw new Error("no body");
      arm();
      frame({ kind: "hello", cursor: lastSeq, resumed: lastSeq > 0 });
      dispatch({ type: "connection", state: "live" });
      attempt = 0;
      const parser = createSSEParser(onEvent);
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        const text = decoder.decode(value, { stream: true });
        if (text.includes(": ping")) frame({ kind: "ping" });
        parser.push(text);
      }
    } finally {
      clearTimeout(stale);
    }
  }

  async function run(): Promise<void> {
    dispatch({ type: "connection", state: "connecting" });
    while (!stopped) {
      try {
        await once();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // the pairing gate takes over
      }
      if (stopped) return;
      dispatch({ type: "connection", state: "offline" });
      const wait = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  }
  void run();

  return () => {
    stopped = true;
    ctrl?.abort();
    wake?.();
  };
}
