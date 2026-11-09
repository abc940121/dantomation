// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
// The day and time line between a conversation's days (ChatView.tsx).
import { cn } from "@/lib/cn";
import { dayLabel, formatTime } from "../lib/day";

export function DaySeparator({ at, today, simple = false }: { at: number; today: number; simple?: boolean }) {
  return (
    <div className={cn("text-center text-[13px] text-ink-secondary", simple ? "pt-5 pb-1 leading-[18px]" : "py-3")}>
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}
