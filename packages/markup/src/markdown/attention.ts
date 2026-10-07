/**
 * Emphasis, strong and strike handlers for remark-stringify that always emit
 * delimiters CommonMark pairs back to the same marks.
 */

import type { Handle, Info, State } from "mdast-util-to-markdown";
import { defaultHandlers } from "mdast-util-to-markdown";
import { classifyCharacter } from "micromark-util-classify-character";

type Parent = { children: readonly unknown[] };
/** remark reads `peek` for the first character a node will write; the type leaves it out. */
type PeekingHandle = Handle & { peek?: (node: unknown, parent: unknown, state: State) => string };
type PhrasingParent = Parameters<State["containerPhrasing"]>[0];

/**
 * Overlapping marks split into sibling runs (`**a *b***` then `* c*`). With one
 * marker everywhere the closing and opening runs fuse into `****` and pair
 * wrongly. Alternating the marker along a chain of adjacent bold or italic
 * runs keeps every neighbouring pair distinct: `*a*__b__*c*`.
 */
function usesUnderscore(node: unknown, parent: Parent | undefined): boolean {
  const children = parent?.children ?? [];
  let index = children.indexOf(node);
  let adjacent = 0;
  while (index > 0) {
    const type = (children[index - 1] as { type?: string }).type;
    if (type !== "emphasis" && type !== "strong") break;
    adjacent += 1;
    index -= 1;
  }
  return adjacent % 2 === 1;
}

function alternatingMarker(option: "emphasis" | "strong", handle: Handle): PeekingHandle {
  const handler: PeekingHandle = (node, parent, state, info) => {
    if (!usesUnderscore(node, parent)) return handle(node, parent, state, info);
    const marker = state.options[option];
    state.options[option] = "_";
    try {
      return handle(node, parent, state, info);
    } finally {
      state.options[option] = marker;
    }
  };
  handler.peek = (node, parent, state) =>
    usesUnderscore(node, parent as Parent | undefined) ? "_" : (state.options[option] ?? "*");
  return handler;
}

/**
 * GFM strikethrough with the same edge encoding remark gives emphasis: a space
 * or punctuation just inside `~~` is written as a character reference, as is the
 * letter outside it, so the run still opens and closes.
 */
const strike: PeekingHandle = (node, _parent, state, info: Info) => {
  const tracker = state.createTracker(info);
  const exit = state.enter("strikethrough" as Parameters<State["enter"]>[0]);
  const before = tracker.move("~~");
  let between = tracker.move(
    state.containerPhrasing(node as PhrasingParent, {
      after: "~",
      before,
      ...tracker.current(),
    }),
  );
  const open = encodeInfo(info.before.charCodeAt(info.before.length - 1), between.charCodeAt(0));
  if (open.inside) between = characterReference(between.charCodeAt(0)) + between.slice(1);
  const tail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), tail);
  if (close.inside) between = between.slice(0, -1) + characterReference(tail);
  const after = tracker.move("~~");
  exit();
  state.attentionEncodeSurroundingInfo = { after: close.outside, before: open.outside };
  return before + between + after;
};
strike.peek = () => "~";

/** mdast-util-to-markdown@2.1.2's private rule for `*`, which upstream notes `~` shares. */
function encodeInfo(outside: number, inside: number): { inside: boolean; outside: boolean } {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  if (outsideKind === undefined) {
    if (insideKind === undefined) return { inside: false, outside: false };
    return insideKind === 1 ? { inside: true, outside: true } : { inside: false, outside: true };
  }
  if (outsideKind === 1) {
    return insideKind === 1 ? { inside: true, outside: true } : { inside: false, outside: false };
  }
  return { inside: insideKind === 1, outside: false };
}

function characterReference(code: number): string {
  return `&#x${code.toString(16).toUpperCase()};`;
}

export const attentionHandlers = {
  emphasis: alternatingMarker("emphasis", defaultHandlers.emphasis),
  strong: alternatingMarker("strong", defaultHandlers.strong),
  delete: strike,
};
