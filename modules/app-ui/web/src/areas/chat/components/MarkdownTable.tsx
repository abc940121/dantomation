// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
// A markdown table: scrolls sideways instead of widening the bubble, with a copy button (tab-separated text).
// Security: keeps react-markdown's already-sanitized cell children; never renders model-authored raw HTML.
import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { useCopyFeedback } from "../lib/copy-text";
import { t } from "@/lib/i18n";

type Element = ReactElement<{ children?: ReactNode; alt?: string }>;
const elements = (children: ReactNode): Element[] => Children.toArray(children).filter(isValidElement) as Element[];

export function plain(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plain).join("");
  if (!isValidElement(node)) return "";
  const element = node as Element;
  if (element.type === "br") return "\n";
  return plain(element.props.children) || element.props.alt || "";
}

function asText(children: ReactNode): string {
  const rows: string[] = [];
  for (const section of elements(children)) {
    for (const row of elements(section.props.children)) {
      rows.push(elements(row.props.children).map((cell) => plain(cell.props.children).replace(/\s+/g, " ").trim()).join("\t"));
    }
  }
  return rows.join("\n");
}

export function MarkdownTable({ children, direction }: { children?: ReactNode; direction?: "rtl" | "ltr" }) {
  const text = useMemo(() => asText(children), [children]);
  const { state, copy } = useCopyFeedback(text);
  const label = state === "copied" ? t("table.copied") : state === "failed" ? t("table.copyFailed") : t("table.copyPlain");
  return (
    <div dir={direction} className="group/table relative my-2.5 rounded-lg border border-hairline/40">
      <button type="button" onClick={copy} title={label} aria-label={label}
        className="table-action absolute end-1 top-1 z-[1] bg-composer opacity-0 ring-[0.5px] ring-ink/10 transition-opacity focus-visible:opacity-100 group-hover/table:opacity-100 touch:opacity-100">
        {state === "copied" ? <Check size={14} className="text-success" aria-hidden="true" /> : state === "failed" ? <X size={14} className="text-danger" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-[13px] leading-5">{children}</table>
      </div>
    </div>
  );
}
