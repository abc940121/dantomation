// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
//
// The call screen. Derived from the phase display of OpenMausBot's CallView (listening, sending, working, speaking),
// reduced to a full-screen status view: no provider menu, no composer, no desktop calls. Presentation only; the
// logic lives in ../VoiceCall.tsx and the state machine.
import { cn } from "@/lib/cn";

export type CallPhase = "idle" | "listening" | "sending" | "working" | "speaking";

export interface CallViewProps {
  phase: CallPhase;
  heard: string;
  reply: string;
  message: string | null;
  t: (key: string) => string;
  onHangup: () => void;
}

const DOT: Record<CallPhase, string> = {
  idle: "bg-ink-secondary",
  listening: "bg-green-500 animate-pulse",
  sending: "bg-amber-400 animate-pulse",
  working: "bg-amber-400 animate-pulse",
  speaking: "bg-sky-400 animate-pulse",
};

export function CallView({ phase, heard, reply, message, t, onHangup }: CallViewProps) {
  return (
    <div role="dialog" aria-modal="true" aria-label={t("voice.title")} className="fixed inset-0 z-50 flex flex-col bg-app text-ink" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <span aria-hidden="true" className={cn("size-24 rounded-full", DOT[phase])} />
        <p className="text-lg font-medium" aria-live="polite">
          {t(`voice.phase.${phase}`)}
        </p>
        {message && (
          <p role="alert" className="max-w-sm text-sm text-red-400">
            {message}
          </p>
        )}
        {heard && (
          <p className="max-w-md text-sm text-ink-secondary">
            <span className="font-medium text-ink">{t("voice.heard")}: </span>
            {heard}
          </p>
        )}
        {reply && (
          <p className="max-h-40 max-w-md overflow-y-auto text-sm text-ink-secondary">
            <span className="font-medium text-ink">{t("voice.reply")}: </span>
            {reply}
          </p>
        )}
        <p className="max-w-xs text-xs text-ink-secondary">{t("voice.hint")}</p>
      </div>
      <div className="flex justify-center p-6">
        <button type="button" onClick={onHangup} className="min-h-12 min-w-40 rounded-full bg-red-600 px-8 text-sm font-medium text-white hover:bg-red-500">
          {t("voice.hangup")}
        </button>
      </div>
    </div>
  );
}
