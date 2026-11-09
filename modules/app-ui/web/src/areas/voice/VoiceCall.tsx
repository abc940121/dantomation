// The hands-free call overlay (our own file, MIT). Wires the pieces together:
//   mic -> VAD (lib/vad.ts) -> state machine (adapter/areas/voice-machine.mjs)
//   browser SpeechRecognition -> final transcript -> POST /m/voice-chat/utterance {inCall:true}
//   reply lines -> speechSynthesis, with playback start/end reported, barge-in cuts the speech
//   POST /m/voice-chat/poll while the call is open, for replies that arrive later.
// There is no push-to-talk: the only controls are start (opening the overlay) and hang up.
import { useCallback, useEffect, useRef, useState } from "react";
import { activeLocale } from "@/lib/i18n";
import { useArea } from "../registry";
import { step, initial } from "../../../../adapter/areas/voice-machine.mjs";
import { CallView, type CallPhase } from "./components/CallView";
import { MicError, startVad, type Vad } from "./lib/vad";

const POLL_MS = 3000;

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

export function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function speechLang(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "zh-TW" : "en-US";
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.slice(0, 2).toLowerCase();
  const same = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(base));
  return same.find((v) => v.lang.toLowerCase().replace("_", "-") === lang.toLowerCase()) ?? same.find((v) => v.default) ?? same[0];
}

type Effect = { type: string; text?: string; state?: string; ms?: number };

export function VoiceCall({ close }: { close: () => void }) {
  const { client, t } = useArea();
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const machine = useRef(initial());
  const run = useRef<(ev: Record<string, unknown>) => void>(() => {});

  const supported = typeof window !== "undefined" && !!recognitionCtor() && "speechSynthesis" in window;
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const blocked = !secure ? t("voice.insecure") : !supported ? t("voice.unsupported") : null;

  useEffect(() => {
    if (blocked) return;
    let alive = true;
    let vad: Vad | null = null;
    let rec: RecognitionLike | null = null;
    let timer: number | undefined;
    let poller: number | undefined;
    let speakId = 0;
    const lang = speechLang(activeLocale());

    const post = (path: string, body: unknown) => client.post<{ lines?: Array<Record<string, unknown>> }>(path, body);

    const speak = (text: string) => {
      const id = ++speakId;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const voice = pickVoice(lang);
      if (voice) u.voice = voice;
      const done = () => id === speakId && alive && dispatch({ type: "speak_end" });
      u.onend = done;
      u.onerror = done;
      setReply(text);
      vad?.setScale(2.5); // our own voice should not count as the user talking
      window.speechSynthesis.speak(u);
    };

    const apply = (effects: Effect[]) => {
      for (const e of effects) {
        switch (e.type) {
          case "start_capture":
            void begin();
            break;
          case "stop_capture":
            teardown();
            break;
          case "send": {
            const text = e.text ?? "";
            setHeard(text);
            post("/m/voice-chat/utterance", { text, spokenAt: Date.now(), inCall: true }).then(
              (r) => alive && dispatch({ type: "reply_lines", lines: r.lines ?? [] }),
              (err) => alive && dispatch({ type: "error", message: String((err as Error).message || "error") }),
            );
            break;
          }
          case "speak":
            speak(e.text ?? "");
            break;
          case "cancel_speech":
            speakId += 1;
            window.speechSynthesis.cancel();
            vad?.setScale(1);
            break;
          case "playback":
            vad?.setScale(e.state === "start" ? 2.5 : 1);
            void post("/m/voice-chat/playback", { state: e.state, at: Date.now() }).catch(() => {});
            break;
          case "timer":
            window.clearTimeout(timer);
            timer = window.setTimeout(() => dispatch({ type: "tick", at: Date.now() }), (e.ms ?? 0) + 5);
            break;
        }
      }
    };

    function dispatch(ev: Record<string, unknown>) {
      const out = step(machine.current, { at: Date.now(), ...ev });
      machine.current = out.state;
      setPhase(out.state.phase as CallPhase);
      if (out.state.error) setMessage(out.state.error);
      apply(out.effects as Effect[]);
    }
    run.current = dispatch;

    function teardown() {
      window.clearTimeout(timer);
      window.clearInterval(poller);
      speakId += 1;
      window.speechSynthesis.cancel();
      if (rec) {
        rec.onend = null;
        rec.onresult = null;
        rec.onerror = null;
        try {
          rec.abort();
        } catch {
          /* already stopped */
        }
        rec = null;
      }
      vad?.close();
      vad = null;
    }

    async function begin() {
      try {
        vad = await startVad({
          onStart: () => alive && dispatch({ type: "vad_start" }),
          onEnd: () => alive && dispatch({ type: "vad_end" }),
        });
      } catch (error) {
        const reason = error instanceof MicError ? error.reason : "failed";
        const key = reason === "blocked" ? "voice.micBlocked" : reason === "missing" ? "voice.micMissing" : "voice.micFailed";
        if (alive) dispatch({ type: "error", fatal: true, message: t(key) });
        return;
      }
      if (!alive) {
        vad.close();
        return;
      }
      const Ctor = recognitionCtor();
      if (!Ctor) return;
      const r = new Ctor();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const res = e.results[i];
          if (res.isFinal) dispatch({ type: "transcript_final", text: res[0].transcript });
          else interim += res[0].transcript;
        }
        setHeard(interim);
      };
      r.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") dispatch({ type: "error", fatal: true, message: t("voice.micBlocked") });
      };
      r.onend = () => {
        // continuous recognition ends on its own now and then; keep the call listening
        if (alive && rec === r) window.setTimeout(() => { try { r.start(); } catch { /* already running */ } }, 250);
      };
      rec = r;
      try {
        r.start();
      } catch {
        /* started by onend */
      }
      poller = window.setInterval(() => {
        const p = machine.current.phase;
        if (p !== "listening" && p !== "working") return;
        post("/m/voice-chat/poll", {}).then(
          (res) => alive && dispatch({ type: "poll_lines", lines: res.lines ?? [] }),
          () => {},
        );
      }, POLL_MS);
    }

    dispatch({ type: "start" });
    return () => {
      alive = false;
      const out = step(machine.current, { type: "stop" });
      machine.current = out.state;
      apply(out.effects as Effect[]);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, client]);

  const hangup = useCallback(() => close(), [close]);

  if (blocked) {
    return <CallView phase="idle" heard="" reply="" message={blocked} t={t} onHangup={hangup} />;
  }
  return <CallView phase={phase} heard={heard} reply={reply} message={message} t={t} onHangup={hangup} />;
}
