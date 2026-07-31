/**
 * Doc → string, at the one moment the composer stops being structural.
 *
 * The wire contract is unchanged by the TipTap migration: `onSubmit(text)`
 * carries a plain string, and everything downstream — the append route, the
 * transcript's reference rendering — reads the same spellings the textarea
 * used to splice. So text serializes verbatim, a hard break is the newline
 * Shift+Enter always meant, paragraphs join on newlines, and a reference
 * token contributes exactly the `spelling` its pick computed.
 */

import type { Fragment, Node as PMNode } from "@tiptap/pm/model";

import { REFERENCE_TOKEN_NODE } from "./reference-token";

/** The hard-break node keeps the manuscript's name (`MeridianHardBreak`). */
const HARD_BREAK_NODE = "hard_break";

function leafText(node: PMNode): string {
  if (node.type.name === HARD_BREAK_NODE) return "\n";
  if (node.type.name === REFERENCE_TOKEN_NODE) return String(node.attrs.spelling ?? "");
  return "";
}

/** The whole message, as `onSubmit` sends it (untrimmed — the caller trims). */
export function serializeComposerText(doc: PMNode): string {
  return serializeComposerFragment(doc.content);
}

/** Any slice of the message — what a copy puts on the clipboard as plain text. */
export function serializeComposerFragment(fragment: Fragment): string {
  return fragment.textBetween(0, fragment.size, "\n", leafText);
}
