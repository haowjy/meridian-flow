/**
 * Export preserves literal wiki-style spans (wikilinks, embeds, callout
 * markers, footnotes), not other Markdown bracket syntax.
 */
import { defaultHandlers, type Handle } from "mdast-util-to-markdown";
import type { MdastText } from "../ast.js";

type Span = { start: number; end: number };

const WIKILINK = /!?\[\[([^[\]\r\n]+)\]\]/g;
const FOOTNOTE = /\[\^[^[\]\s\\]+\]/g;
const CALLOUT = /^\[![\w-]+\]/;

/**
 * Text nodes that open a quote's first line. The text handler has no ancestor chain, and a
 * quote is a step in its blocks' nesting, so the paragraph codec records them.
 */
const calloutLeads = new WeakSet<object>();

export function markQuoteLead(node: object | undefined): void {
  if ((node as { type?: string } | undefined)?.type === "text") calloutLeads.add(node as object);
}

export const exportText: Handle = (node, parent, state, info) => {
  const value = (node as MdastText).value;
  const spans = verbatimSpans(node, value, info);
  if (!spans.length) return defaultHandlers.text(node, parent, state, info);
  let result = "";
  let offset = 0;
  for (const span of spans) {
    result += defaultHandlers.text(
      { type: "text", value: value.slice(offset, span.start) },
      parent,
      state,
      {
        ...info,
        before: offset ? value.slice(0, offset) : info.before,
        after: value.slice(span.start, span.end),
      },
    );
    result += value.slice(span.start, span.end);
    offset = span.end;
  }
  return (
    result +
    defaultHandlers.text({ type: "text", value: value.slice(offset) }, parent, state, {
      ...info,
      before: value.slice(0, offset),
    })
  );
};

function verbatimSpans(node: object, value: string, info: { before: string; after: string }) {
  const candidates: Span[] = [];
  const callout = calloutLeads.has(node) ? CALLOUT.exec(value) : null;
  if (callout) candidates.push({ start: 0, end: callout[0].length });
  for (const match of value.matchAll(WIKILINK))
    candidates.push({ start: match.index, end: match.index + match[0].length });
  for (const match of value.matchAll(FOOTNOTE)) {
    const start = match.index;
    const end = start + match[0].length;
    // `[^1](url)`, `[^1][x]`, `[a][^1]` and `![^1]` can still form a link or
    // image, so those stay escaped.
    const previous = start ? value[start - 1] : info.before.at(-1);
    const next = end < value.length ? value[end] : info.after[0];
    if (previous !== "]" && previous !== "!" && next !== "(" && next !== "[")
      candidates.push({ start, end });
  }
  candidates.sort((a, b) => a.start - b.start);
  const spans: Span[] = [];
  for (const span of candidates) {
    const last = spans.at(-1);
    if (!last || span.start >= last.end) spans.push(span);
  }
  return spans;
}
