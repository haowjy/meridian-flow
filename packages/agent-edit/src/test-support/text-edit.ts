/** Writer-side text edit for tests: the editor's binding is not under test, so a replace is one splice. */

import * as Y from "yjs";
import type { Span } from "../codec-types.js";
import type { BlockRef } from "../handles.js";
import { toRef, unwrapBlock } from "../handles.js";

interface TextSegment {
  text: Y.XmlText;
  start: number;
  length: number;
}

function collectText(type: Y.XmlElement | Y.XmlText): string {
  if (type instanceof Y.XmlText)
    return (type.toDelta() as Array<{ insert?: unknown }>)
      .map((delta) => (typeof delta.insert === "string" ? delta.insert : ""))
      .join("");
  return type
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || child instanceof Y.XmlElement ? collectText(child) : "",
    )
    .join("");
}

export function applyTextEdit(block: Y.XmlElement | BlockRef, span: Span, newText: string): void {
  block = unwrapBlock(toRef(block));
  const text = collectText(block);
  if (span.from < 0 || span.to < span.from || span.to > text.length) {
    throw new RangeError(
      `Invalid text span ${span.from}..${span.to} for block length ${text.length}`,
    );
  }

  // Equal text at either edge stays, so its items, anchors and attribution survive.
  const trimmed = trimUnchangedEdges(text.slice(span.from, span.to), newText);
  span = { from: span.from + trimmed.prefix, to: span.to - trimmed.suffix };
  newText = trimmed.text;
  if (span.from === span.to && newText.length === 0) return;

  const segments = collectTextSegments(block);
  const insertAttrs = attributesAtFlatOffset(segments, span.from);

  // Insert before deleting: an insert into an already-deleted run anchors
  // after it, beside any writer text typed at its end, and Yjs then orders
  // the two by client id, which can put the writer's words in front.
  if (newText.length > 0) {
    const insertion = insertionPoint(block, segments, span.from);
    insertion.text.insert(insertion.offset, newText, insertAttrs);
  }
  const from = span.from + newText.length;
  const to = span.to + newText.length;
  for (const segment of collectTextSegments(block).reverse()) {
    const segmentFrom = Math.max(from, segment.start);
    const segmentTo = Math.min(to, segment.start + segment.length);
    if (segmentFrom < segmentTo) {
      segment.text.delete(segmentFrom - segment.start, segmentTo - segmentFrom);
    }
  }
}

function trimUnchangedEdges(
  oldText: string,
  newText: string,
): { prefix: number; suffix: number; text: string } {
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  // Never split a surrogate pair: Yjs would store each half as a broken character.
  if (prefix > 0 && isHighSurrogate(newText.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(newText.charCodeAt(newText.length - suffix))) suffix -= 1;
  return { prefix, suffix, text: newText.slice(prefix, newText.length - suffix) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function collectTextSegments(block: Y.XmlElement): TextSegment[] {
  const segments: TextSegment[] = [];
  let offset = 0;
  const visit = (type: Y.XmlElement | Y.XmlText) => {
    if (type instanceof Y.XmlText) {
      const length = type.length;
      segments.push({ text: type, start: offset, length });
      offset += length;
      return;
    }
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(block);
  return segments;
}

function attributesAtFlatOffset(
  segments: readonly TextSegment[],
  flatOffset: number,
): Record<string, unknown> | undefined {
  for (const segment of segments) {
    if (flatOffset >= segment.start && flatOffset <= segment.start + segment.length) {
      return attributesAt(segment.text, flatOffset - segment.start);
    }
  }
  return undefined;
}

function attributesAt(text: Y.XmlText, offset: number): Record<string, unknown> | undefined {
  let cursor = 0;
  let previous: Record<string, unknown> | undefined;
  for (const delta of text.toDelta() as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 0;
    const attrs = delta.attributes;
    if (offset >= cursor && offset < cursor + length) return attrs;
    if (offset === cursor + length) previous = attrs;
    cursor += length;
  }
  return previous;
}

function insertionPoint(
  block: Y.XmlElement,
  segments: readonly TextSegment[],
  flatOffset: number,
): { text: Y.XmlText; offset: number } {
  for (const segment of segments) {
    if (flatOffset >= segment.start && flatOffset <= segment.start + segment.length) {
      return { text: segment.text, offset: flatOffset - segment.start };
    }
  }
  const text = new Y.XmlText();
  block.insert(0, [text]);
  return { text, offset: 0 };
}
