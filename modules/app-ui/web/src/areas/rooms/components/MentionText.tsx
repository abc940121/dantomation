// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors

import { Fragment, type CSSProperties } from "react";
import { mentionClassName, mentionRanges, type MentionPeer } from "../lib/mentions";

export function MentionText({ text, peers, everyone = false }: {
  text: string; peers: readonly MentionPeer[]; everyone?: boolean;
}) {
  let end = 0;
  const parts = mentionRanges(text, peers, everyone).map((range) => {
    const prefix = text.slice(end, range.start);
    end = range.end;
    const style = range.color ? { "--mention-color": range.color } as CSSProperties : undefined;
    return <Fragment key={range.start}>{prefix}<span className={mentionClassName()} style={style}>{text.slice(range.start, range.end)}</span></Fragment>;
  });
  return <>{parts}{text.slice(end)}</>;
}
