/**
 * Export preserves literal Obsidian-shaped spans (wikilinks, embeds, callout
 * markers, footnotes), not other Markdown bracket syntax.
 */
import { defaultHandlers, type Handle } from "mdast-util-to-markdown";
import type { MdastText } from "../ast.js";

type Span = { start: number; end: number };
type Parent = { type: string; children?: readonly { type: string }[] };

const WIKILINK = /!?\[\[([^[\]\r\n]+)\]\]/g;
const FOOTNOTE = /\[\^[^[\]\s\\]+\]/g;
const CALLOUT = /^\[![\w-]+\]/;

/**
 * Text nodes that open a blockquote's first line. The text handler has no
 * ancestor chain, so the blockquote handler records them on the way down.
 */
const calloutLeads = new WeakSet<object>();

export const exportBlockquote: Handle = (node, parent, state, info) => {
  const first = (node as Parent).children?.[0] as Parent | undefined;
  const lead = first?.type === "paragraph" ? first.children?.[0] : undefined;
  if (lead?.type === "text") calloutLeads.add(lead);
  return defaultHandlers.blockquote(node, parent, state, info);
};

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
