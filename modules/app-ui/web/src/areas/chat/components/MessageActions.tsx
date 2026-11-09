// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
// The small actions under a message: copy, and toggle raw markdown. They show on hover, on keyboard focus and
// on a tap (touch), as in the original; its overflow menu, reply, fork and the rest are cut.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Code, Copy, Eye, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useCopyFeedback } from "../lib/copy-text";

export const ACTION_ICON = { size: 17, strokeWidth: 1.5 } as const;

export const messageActionClass =
  "inline-flex size-7 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50";

export const MESSAGE_ROW = "data-message-row";

export function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopyFeedback(text);
  const label = t(state === "copied" ? "chat.copyMessageDone" : state === "failed" ? "chat.copyMessageFailed" : "chat.copyMessage");
  return (
    <button type="button" onClick={copy} aria-label={label} title={label} className={messageActionClass}>
      {state === "copied" ? <Check {...ACTION_ICON} className="text-success" aria-hidden="true" />
        : state === "failed" ? <X {...ACTION_ICON} className="text-danger" aria-hidden="true" />
          : <Copy {...ACTION_ICON} aria-hidden="true" />}
    </button>
  );
}

export function RawToggle({ raw, onToggle }: { raw: boolean; onToggle: () => void }) {
  const label = t(raw ? "chat.showRenderedMarkdown" : "chat.showRawMarkdown");
  return (
    <button type="button" onClick={onToggle} aria-label={label} aria-pressed={raw} title={label} className={cn(messageActionClass, raw && "bg-ink/10 text-ink")}>
      {raw ? <Eye {...ACTION_ICON} aria-hidden="true" /> : <Code {...ACTION_ICON} aria-hidden="true" />}
    </button>
  );
}

export function MessageActions({ side, children, className }: { side: "user" | "bot"; children?: ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const shown = hovered || focused || tapped;

  useEffect(() => {
    const row = root.current?.closest<HTMLElement>(`[${MESSAGE_ROW}]`);
    if (!row) return;
    const enter = (e: PointerEvent) => { if (e.pointerType !== "touch") setHovered(true); };
    const leave = (e: PointerEvent) => { if (e.pointerType !== "touch") setHovered(false); };
    const focusIn = (e: FocusEvent) => {
      try { setFocused(e.target instanceof Element && e.target.matches(":focus-visible")); } catch { setFocused(false); }
    };
    const focusOut = (e: FocusEvent) => { if (!(e.relatedTarget instanceof Node && row.contains(e.relatedTarget))) setFocused(false); };
    // A touch tap on the text (not a link or button, and not ending a text selection) shows or hides the actions.
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (e.target instanceof Element && e.target.closest("a, button, input, textarea, summary")) return;
      if (window.getSelection()?.toString()) return;
      setTapped((v) => !v);
    };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    row.addEventListener("pointerup", up);
    return () => {
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      row.removeEventListener("pointerup", up);
    };
  }, []);

  return (
    <div
      ref={root}
      data-testid="message-actions"
      data-shown={shown ? "true" : undefined}
      className={cn(
        "flex items-center gap-0.5 self-end pb-0.5 transition-opacity duration-150",
        side === "user" && "flex-row-reverse",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
