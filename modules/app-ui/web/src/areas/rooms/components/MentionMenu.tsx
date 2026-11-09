// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import type { RefObject } from "react";
import { Users } from "lucide-react";
import { useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { Avatar } from "@/shell/Avatar";

/** One row of the @ list: a room member, or everyone. */
export type MentionChoice = { id: string; name: string; member?: true; everyone?: true };

export const EVERYONE_ID = "__everyone__";

/** The composer's @ list. */
export function MentionMenu({ listRef, choices, highlight, everyoneCount, onPick, onHighlight, className }: {
  listRef: RefObject<HTMLDivElement | null>;
  choices: MentionChoice[];
  highlight: number;
  everyoneCount: number;
  onPick: (choice: MentionChoice) => void;
  onHighlight: (index: number) => void;
  className?: string;
}) {
  const { t } = useArea();
  if (!choices.length) return null;
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("rooms.mention.aria")}
      data-testid="mention-menu"
      className={cn("absolute bottom-full start-2 z-20 mb-2 max-h-72 w-72 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg", className)}
    >
      {choices.map((choice, i) => (
        <button
          key={choice.id}
          type="button"
          id={`rooms-mention-${choice.id}`}
          role="option"
          data-mention-index={i}
          aria-selected={i === highlight}
          // Keep the textarea focused: a click picks, it does not blur.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(choice)}
          onMouseEnter={() => onHighlight(i)}
          className={cn("flex min-h-11 w-full items-center gap-3 px-3 py-2 text-start", i === highlight && "bg-raised-hover")}
        >
          {choice.member ? (
            <Avatar id={choice.id} name={choice.name} size={24} />
          ) : (
            <span className="flex size-6 items-center justify-center rounded-full bg-inset text-ink-secondary">
              <Users size={14} aria-hidden="true" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink">{choice.name}</span>
            {choice.everyone ? <span className="block truncate text-xs text-ink-secondary">{t("rooms.mention.everyoneDesc", { count: everyoneCount })}</span> : null}
          </span>
          <span className="shrink-0 text-xs text-ink-tertiary">{choice.member ? t("rooms.mention.member") : t("rooms.mention.channel")}</span>
        </button>
      ))}
    </div>
  );
}
