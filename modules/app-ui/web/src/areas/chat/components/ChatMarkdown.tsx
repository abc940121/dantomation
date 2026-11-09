// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
// Chat markdown: GFM, math (KaTeX, loaded on first use), highlighted code, tables. Raw HTML is never rendered.
// Cut from the original: mentions, thread links, file/image previews, spoilers, mermaid, GitHub refs.
import { memo, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { fromMarkdown, type Options as MarkdownParseOptions } from "mdast-util-from-markdown";
import { createMarkdownRenderCache } from "../lib/markdown-render-cache";
import { parseFenceInfo } from "../lib/code-block";
import { repairMarkdownTables } from "../lib/markdown-tables";
import { TRANSCRIPT_WINDOW_SIZE } from "../lib/transcript-window";
import { CodeBlock } from "./CodeBlock";
import { MarkdownTable } from "./MarkdownTable";

export { CodeBlock, HIGHLIGHT_CACHE_MAX, HIGHLIGHT_CACHE_MAX_CHARS, HIGHLIGHT_MAX_CHARS, type CodeBlockProps } from "./CodeBlock";

const LINK_CLASS = "break-words text-accent underline decoration-accent/40 hover:decoration-accent [unicode-bidi:isolate]";

/** Links keep the default scheme allow-list (http, https, mailto, tel, irc); everything else is dropped. */
export function chatUrlTransform(value: string): string {
  return defaultUrlTransform(value);
}

const gfmParseData: {
  micromarkExtensions?: MarkdownParseOptions["extensions"];
  fromMarkdownExtensions?: MarkdownParseOptions["mdastExtensions"];
} = {};
// A spoiler is "~~text~~" only: a lone "~" in a range such as "77~82" must not hide what follows it.
const GFM_OPTIONS = { singleTilde: false };
remarkGfm.call({ data: () => gfmParseData }, GFM_OPTIONS);
const normalizationParseOptions: MarkdownParseOptions = {
  extensions: gfmParseData.micromarkExtensions,
  mdastExtensions: gfmParseData.fromMarkdownExtensions,
};


/** A single line break in a reply is a line break, as chat apps show it, not a space. */
function remarkSoftBreaks() {
  return (tree: { children?: any[] }) => {
    const visit = (node: { children?: any[] }) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child?.type !== "text" || !child.value.includes("\n")) {
          visit(child);
          return [child];
        }
        return (child.value as string).split("\n").flatMap((value, index) => [
          ...(index ? [{ type: "break" }] : []),
          ...(value ? [{ type: "text", value }] : []),
        ]);
      });
    };
    visit(tree);
  };
}
// Not dir="auto": that algorithm skips descendants carrying their own dir, so a blockquote or table of per-block
// directions falls back to LTR. JS regexes cannot match Bidi_Class, so these are the blocks Unicode reserves for
// right-to-left letters.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

export function textDirection(value: string): "rtl" | "ltr" {
  const strong = /\p{Letter}/u.exec(value);
  return strong && RTL_LETTER.test(strong[0]) ? "rtl" : "ltr";
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function blockText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code" || node.tagName === "pre") return "";
  return (node.children ?? []).map(blockText).join("");
}

export function blockDirection(node: unknown): "rtl" | "ltr" {
  return textDirection(blockText(node as HastNode));
}

interface BlockProps {
  node?: unknown;
  children?: ReactNode;
}

interface BlockProps {
  node?: unknown;
  children?: ReactNode;
}


const CURRENCY_DOLLAR = /(?<![$\p{L}\p{N}])(?:R|US|AU|A|CA|C|NZ|HK|SG|S|MX|NT|BZ|Z)\$(?=[ \t\u00a0]?\d)/gu;

/**
 * Pandoc's rule: an opening `$` is followed by non-space, a closing `$` is preceded by non-space and not followed by a
 * digit, and the pair stays inside one paragraph.
 */
function escapeLiteralDollars(text: string): string {
  const display: string[] = [];
  const hidden = text
    .replace(/\$\$[\s\S]*?\$\$/g, (math) => `\u0000OMB_MATH_${display.push(math) - 1}\u0000`)
    .replace(CURRENCY_DOLLAR, (sign) => `${sign.slice(0, -1)}\\$`);
  const literal = new Set<number>();
  const singles: number[] = [];
  for (let i = 0; i < hidden.length; i++) {
    if (hidden[i] === "\\") i++;
    else if (hidden[i] === "$") singles.push(i);
  }
  let open: number | null = null;
  for (const at of singles) {
    if (open !== null) {
      const closes = !/\s/.test(hidden[at - 1]) && !/\d/.test(hidden[at + 1] ?? "")
        && !/\n[ \t]*\n/.test(hidden.slice(open, at));
      if (closes) { open = null; continue; }
      literal.add(open);
    }
    open = /\S/.test(hidden[at + 1] ?? "") ? at : null;
    if (open === null) literal.add(at);
  }
  if (open !== null) literal.add(open);
  let escaped = "";
  for (let i = 0; i < hidden.length; i++) escaped += literal.has(i) ? "\\$" : hidden[i];
  display.forEach((math, index) => {
    escaped = escaped.split(`\u0000OMB_MATH_${index}\u0000`).join(math);
  });
  return escaped;
}

export function normalizeMathDelimiters(text: string, imageOffsets?: Map<number, number>): string {
  const protectedCode: Array<{ value: string; sourceOffset: number }> = [];
  const protect = (value: string, sourceOffset: number): string => {
    const token = `\u0000OMB_CODE_${protectedCode.length}\u0000`;
    protectedCode.push({ value, sourceOffset });
    return token;
  };
  const spans: Array<{ start: number; end: number }> = [];
  const imageStarts: number[] = [];
  const visit = (node: { type: string; children?: any[]; position?: { start: { offset?: number }; end: { offset?: number } } }, protectedParent = false) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const image = node.type === "image" || node.type === "imageReference";
    if (image && start !== undefined) imageStarts.push(start);
    const labelEnd = node.type === "link" && start !== undefined && text[start] === "["
      ? node.children?.at(-1)?.position?.end.offset : undefined;
    const protectedNode = node.type === "code" || node.type === "inlineCode" || node.type === "definition" || node.type === "linkReference" || node.type === "link" || (imageOffsets !== undefined && image);
    if (!protectedParent && protectedNode && start !== undefined && end !== undefined) {
      spans.push({ start: labelEnd ?? start, end });
    }
    node.children?.forEach((child) => visit(child, protectedParent || (protectedNode && labelEnd === undefined)));
  };
  visit(fromMarkdown(text, normalizationParseOptions));
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + protect(text.slice(start, end), start) + text.slice(end);
  }
  let normalized = text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => `$$\n${math}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => `$${math.trim()}$`)
    // remark-math treats flow math as a block only when the fences occupy their own lines.
    .replace(/\$\$[ \t]*([^\n][\s\S]*?)[ \t]*\$\$/g, (_match, math: string) => `$$\n${math}\n$$`);
  normalized = escapeLiteralDollars(normalized);
  let shift = 0;
  // oxlint-disable-next-line no-control-regex -- restore opaque code and image sentinels
  normalized = normalized.replace(/\u0000OMB_CODE_(\d+)\u0000/g, (token, index: string, at: number) => {
    const part = protectedCode[Number(index)];
    if (!part) return token;
    const { value, sourceOffset } = part;
    for (const imageOffset of imageStarts) {
      if (imageOffset >= sourceOffset && imageOffset < sourceOffset + value.length) {
        imageOffsets?.set(at + shift + imageOffset - sourceOffset, imageOffset);
      }
    }
    shift += value.length - token.length;
    return value;
  });
  return normalized;
}

const normalizedCache = new Map<string, string>();
const NORMALIZED_CACHE_MAX = TRANSCRIPT_WINDOW_SIZE * 2;

function normalizeMessageMarkdown(text: string): string {
  const cached = normalizedCache.get(text);
  if (cached !== undefined) return cached;
  const source = normalizeMathDelimiters(repairMarkdownTables(text));
  if (normalizedCache.size >= NORMALIZED_CACHE_MAX) {
    const first = normalizedCache.keys().next().value;
    if (first !== undefined) normalizedCache.delete(first);
  }
  normalizedCache.set(text, source);
  return source;
}


type KatexPlugin = NonNullable<MarkdownOptions["rehypePlugins"]>[number];
let katexPlugin: KatexPlugin | null = null;
let katexLoad: Promise<void> | null = null;

export function ensureChatKatex(): Promise<void> {
  if (katexPlugin) return Promise.resolve();
  katexLoad ??= import("rehype-katex").then(async (mod) => {
    if (typeof document !== "undefined") await import("katex/dist/katex.min.css");
    katexPlugin = mod.default;
  }).catch(error => {
    katexLoad = null;
    throw error;
  });
  return katexLoad;
}

function normalizedSourceHasMath(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 92) {
      i += 1;
      continue;
    }
    if (source[i] !== "$") continue;
    const next = source[i + 1];
    if (next === undefined) return false;
    if (next === "$") {
      if (source.indexOf("$$", i + 2) !== -1) return true;
      i += 1;
      continue;
    }
    return source.indexOf("$", i + 1) !== -1;
  }
  return false;
}

export function messageNeedsKatex(text: string): boolean {
  return normalizedSourceHasMath(normalizeMessageMarkdown(text));
}

function MarkdownCode({ node, children }: BlockProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child: any = Array.isArray(children) ? children[0] : children;
  const className: string = child?.props?.className ?? "";
  const { lang, wrap } = parseFenceInfo(/language-([^\s]+)/.exec(className)?.[1] ?? "", (node as { children?: { data?: { meta?: unknown } }[] })?.children?.[0]?.data?.meta);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flat = (n: any): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
  const code = flat(child?.props?.children).replace(/\n$/, "");
  return <CodeBlock code={code} lang={lang} initialWrap={wrap} />;
}

/** An image is never fetched by the chat: it shows as a link to its address (a remote image would leak the viewer's address). */
function MarkdownImage(props: ComponentProps<"img"> & ExtraProps) {
  const { src, alt } = props;
  if (!src) return <span className="text-ink-secondary">{alt}</span>;
  return <a href={src} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>{alt || src}</a>;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>{children}</a>;
}

const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownCode,
  img: MarkdownImage,
  code({ children }: { children?: ReactNode }) {
    return <code dir="ltr" className="ui-code-chip break-words [unicode-bidi:isolate]">{children}</code>;
  },
  a: MarkdownLink,
  table({ node, children }: BlockProps) {
    return <MarkdownTable direction={blockDirection(node)}>{children}</MarkdownTable>;
  },
  ol({ node, children }: BlockProps) {
    return <ol dir={blockDirection(node)} className="list-decimal space-y-1 ps-5">{children}</ol>;
  },
  h1({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-3 text-[18px] font-semibold">{children}</div>;
  },
  h2({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-2 text-[16px] font-semibold">{children}</div>;
  },
  h3({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 font-semibold">{children}</div>;
  },
  h4({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 font-semibold">{children}</div>;
  },
  h5({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 text-[14px] font-semibold">{children}</div>;
  },
  h6({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 text-[14px] font-semibold text-ink-secondary">{children}</div>;
  },
  blockquote({ node, children }: BlockProps) {
    return (
      <blockquote dir={blockDirection(node)} className="border-s-2 border-hairline ps-3 text-ink-secondary">{children}</blockquote>
    );
  },
  hr() {
    return <hr className="border-hairline/40" />;
  },
};

const BASE_REMARK_PLUGINS: NonNullable<MarkdownOptions["remarkPlugins"]> = [[remarkGfm, GFM_OPTIONS], remarkMath, remarkSoftBreaks];
const NO_REHYPE_PLUGINS: NonNullable<MarkdownOptions["rehypePlugins"]> = [];
let katexPlugins: { plugin: KatexPlugin; list: NonNullable<MarkdownOptions["rehypePlugins"]> } | null = null;
const rehypePluginsFor = (math: KatexPlugin | null) => {
  if (!math) return NO_REHYPE_PLUGINS;
  if (katexPlugins?.plugin !== math) katexPlugins = { plugin: math, list: [math] };
  return katexPlugins!.list;
};

const markdownCache = createMarkdownRenderCache();

/** Test seam: drops every cached message. */
export function clearChatMarkdownCache(): void {
  markdownCache.clear();
}

function ChatMarkdownComponent({ text }: { text: string }) {
  const source = normalizeMessageMarkdown(text);
  const needsMath = normalizedSourceHasMath(source);
  const [katexReady, setKatexReady] = useState(() => katexPlugin !== null);
  useEffect(() => {
    if (!needsMath) return;
    if (katexPlugin) {
      setKatexReady(true);
      return;
    }
    let alive = true;
    void ensureChatKatex().then(() => {
      if (alive) setKatexReady(true);
    }, () => {
    });
    return () => {
      alive = false;
    };
  }, [needsMath]);
  const mathPlugin = needsMath && katexReady ? katexPlugin : null;
  const variant = mathPlugin ? "math" : "";
  // Markdown is a plain function of its options (no hooks), so its elements can be kept and drawn again.
  const markdown = markdownCache.render(text, variant, () =>
    Markdown({ children: source, remarkPlugins: BASE_REMARK_PLUGINS, rehypePlugins: rehypePluginsFor(mathPlugin), urlTransform: chatUrlTransform, components: MARKDOWN_COMPONENTS }));
  return <div className="chat-md min-w-0 [&>*+*]:mt-2">{markdown}</div>;
}

export const ChatMarkdown = memo(ChatMarkdownComponent, (previous, next) => previous.text === next.text);
