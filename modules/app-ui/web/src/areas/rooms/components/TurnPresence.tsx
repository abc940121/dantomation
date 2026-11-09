// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const SHEEN_PERIOD_MS = 2000;

function ShimmerPhrase({ text, className }: { text: string; className?: string }) {
  const [delay] = useState(() => `-${Date.now() % SHEEN_PERIOD_MS}ms`);
  return (
    <span className={cn("thinking-shimmer", className)} style={{ "--sheen-period": `${SHEEN_PERIOD_MS}ms`, "--sheen-delay": delay } as CSSProperties}>
      {text}
      <span aria-hidden="true" className="thinking-sheen"><span data-text={text} /></span>
    </span>
  );
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Counts up from `since` once a second. */
function Timer({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className={cn("tabular-nums", className)}>{formatElapsed(now - since)}</span>;
}

/** The speaker's live status line: avatar, a shimmering label and a timer. Rendered only while `visible`. */
export function TurnPresence({ avatar, visible, label, since, className }: {
  avatar: ReactNode;
  visible: boolean;
  label: string;
  since: number | null;
  className?: string;
}) {
  if (!visible) return null;
  return (
    <div className={cn("flex min-w-0 max-w-full items-center gap-2", className)} data-testid="turn-presence" role="status" aria-live="polite">
      {avatar}
      <span className="flex min-w-0 items-baseline gap-x-1.5 leading-none">
        <ShimmerPhrase text={label} className="truncate text-[13px]" />
        {since !== null && (
          <>
            <span aria-hidden="true" className="text-[12px] text-ink-tertiary"> · </span>
            <Timer since={since} className="text-[12px] text-ink-tertiary" />
          </>
        )}
      </span>
    </div>
  );
}
