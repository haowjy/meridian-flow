import type * as Y from "yjs";

import type { Codec } from "../codec/types.js";
import type { AgentEditModel } from "../ports/model.js";
import type { BlockScope } from "./scope.js";

const EMPTY_PARAGRAPH_SENTINEL = "\u00a0";

export interface FindContext {
  doc: Y.Doc;
  model: AgentEditModel;
  codec: Codec;
}

export interface FindMatch {
  kind: "single-block";
  element: Y.XmlElement;
  span: { start: number; end: number };
  absoluteStart: number;
  absoluteEnd: number;
}

export interface CrossBlockFindMatch {
  kind: "cross-block";
  elements: Y.XmlElement[];
  startIndex: number;
  endIndex: number;
  rangeSource: string;
  matchStart: number;
  matchEnd: number;
  endElement: Y.XmlElement;
  endSpan: { start: number; end: number };
  absoluteStart: number;
  absoluteEnd: number;
}

export type TextFindMatch = FindMatch | CrossBlockFindMatch;

export type FindResult =
  | { ok: true; matches: TextFindMatch[] }
  | {
      ok: false;
      code: "not_found" | "ambiguous_match" | "invalid_write";
      message: string;
      count?: number;
    };

interface SerializedBlockEntry {
  block: Y.XmlElement;
  index: number;
  body: string;
  flatText: string;
  start: number;
  end: number;
}

export function findTextMatches(
  ctx: FindContext,
  scope: BlockScope,
  find: string,
  all: boolean,
): FindResult {
  if (find.length === 0) return invalid("`find` must not be empty");
  const entries = serializeScopeBlocks(ctx, scope);
  const haystack = entries.map((entry) => entry.body).join("\n\n");
  const normalized = normalizeWithOffsetMap(haystack);
  const matches = nonOverlappingMatches(normalized.text, find.normalize("NFC")).map((match) => ({
    start: normalized.originalStart[match.start],
    end: normalized.originalEnd[match.end - 1],
  }));
  if (matches.length === 0) return notFound(`Could not find "${find}" in the selected scope`);
  if (matches.length > 1 && !all) {
    return {
      ok: false,
      code: "ambiguous_match",
      message: `Found ${matches.length} matches for "${find}". Narrow with in/around or use all=true.`,
      count: matches.length,
    };
  }

  const resolved = matches.map((match) => resolveMatch(entries, match.start, match.end));
  if (resolved.some((match) => match === null)) {
    return invalid("Could not map find match to editable block spans");
  }
  return {
    ok: true,
    matches: resolved.filter((match): match is TextFindMatch => match !== null),
  };
}

export function serializeBlockBody(ctx: FindContext, block: Y.XmlElement): string {
  const pmBlock = ctx.model.toProsemirrorBlock(ctx.doc, block);
  const body = trimOneTrailingNewline(ctx.codec.serialize([pmBlock]));
  return body === EMPTY_PARAGRAPH_SENTINEL ? "" : body;
}

export function serializePmBlockBody(
  ctx: Pick<FindContext, "codec">,
  block: Parameters<Codec["serialize"]>[0][number],
): string {
  const body = trimOneTrailingNewline(ctx.codec.serialize([block]));
  return body === EMPTY_PARAGRAPH_SENTINEL ? "" : body;
}

function serializeScopeBlocks(ctx: FindContext, scope: BlockScope): SerializedBlockEntry[] {
  let cursor = 0;
  return scope.blocks.map((block, index) => {
    const body = serializeBlockBody(ctx, block);
    const entry = {
      block,
      index: scope.startIndex + index,
      body,
      flatText: ctx.model.getText(block),
      start: cursor,
      end: cursor + body.length,
    };
    cursor = entry.end + (index === scope.blocks.length - 1 ? 0 : 2);
    return entry;
  });
}

function nonOverlappingMatches(
  haystack: string,
  needle: string,
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    matches.push({ start: index, end: index + needle.length });
    cursor = index + Math.max(needle.length, 1);
  }
  return matches;
}

function normalizeWithOffsetMap(input: string): {
  text: string;
  originalStart: number[];
  originalEnd: number[];
} {
  const originalStart: number[] = [];
  const originalEnd: number[] = [];
  let text = "";
  for (const match of input.matchAll(/\P{Mark}\p{Mark}*|\p{Mark}+/gu)) {
    const source = match[0];
    const start = match.index;
    const end = start + source.length;
    const normalized = source.normalize("NFC");
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      originalStart.push(start);
      originalEnd.push(end);
    }
  }
  return { text, originalStart, originalEnd };
}

function resolveMatch(
  entries: readonly SerializedBlockEntry[],
  start: number,
  end: number,
): TextFindMatch | null {
  const firstIndex = entries.findIndex((entry) => start <= entry.end && end > entry.start);
  const lastIndex = findLastIndex(entries, (entry) => start < entry.end && end >= entry.start);
  if (firstIndex < 0 || lastIndex < firstIndex) return null;
  const entry = entries[firstIndex];
  if (firstIndex !== lastIndex || start < entry.start || end > entry.end) {
    return resolveCrossBlockMatch(entries.slice(firstIndex, lastIndex + 1), start, end);
  }
  const localStart = start - entry.start;
  const localEnd = end - entry.start;
  const span = serializedOffsetsToFlatSpan(entry, localStart, localEnd);
  if (!span) return null;
  return {
    kind: "single-block",
    element: entry.block,
    span,
    absoluteStart: start,
    absoluteEnd: end,
  };
}

function resolveCrossBlockMatch(
  entries: readonly SerializedBlockEntry[],
  start: number,
  end: number,
): CrossBlockFindMatch | null {
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last || entries.length < 2) return null;
  const rangeSource = entries.map((entry) => entry.body).join("\n\n");
  const matchStart = start - first.start;
  const matchEnd = end - first.start;
  if (matchStart < 0 || matchEnd < matchStart || matchEnd > rangeSource.length) return null;

  const endLocal = Math.min(Math.max(end - last.start, 0), last.body.length);
  const endSpan = serializedOffsetsToFlatSpan(last, endLocal, endLocal);
  if (!endSpan) return null;

  return {
    kind: "cross-block",
    elements: entries.map((entry) => entry.block),
    startIndex: first.index,
    endIndex: last.index,
    rangeSource,
    matchStart,
    matchEnd,
    endElement: last.block,
    endSpan,
    absoluteStart: start,
    absoluteEnd: end,
  };
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function serializedOffsetsToFlatSpan(
  entry: SerializedBlockEntry,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (entry.body === entry.flatText) return { start, end };
  const bodyToFlat = serializedBodyToFlatOffsetMap(entry.body, entry.flatText);
  if (!bodyToFlat) return null;
  const flatStart = bodyToFlat[start];
  const flatEnd = bodyToFlat[end];
  if (flatStart === undefined || flatEnd === undefined || flatEnd < flatStart) return null;
  return { start: flatStart, end: flatEnd };
}

interface TextCluster {
  text: string;
  normalized: string;
  start: number;
  end: number;
}

function serializedBodyToFlatOffsetMap(
  body: string,
  flatText: string,
): Array<number | undefined> | null {
  const bodyClusters = textClusters(body);
  const flatClusters = textClusters(flatText);
  const offsets: Array<number | undefined> = Array.from({ length: body.length + 1 });
  let flatIndex = 0;

  // The serialized body is the flat editable text plus zero-width markdown syntax.
  // Align NFC text clusters in order and map unmatched serialized clusters to the
  // current flat boundary so anchors copied from view resolve to editable spans.

  for (const bodyCluster of bodyClusters) {
    const flatCluster = flatClusters[flatIndex];
    if (flatCluster && bodyCluster.normalized === flatCluster.normalized) {
      mapMatchedCluster(offsets, bodyCluster, flatCluster);
      flatIndex += 1;
      continue;
    }
    mapSkippedCluster(offsets, bodyCluster, flatOffsetAt(flatClusters, flatIndex, flatText.length));
  }

  const finalFlatOffset = flatOffsetAt(flatClusters, flatIndex, flatText.length);
  offsets[body.length] = finalFlatOffset;
  return flatIndex === flatClusters.length ? offsets : null;
}

function textClusters(text: string): TextCluster[] {
  return Array.from(text.matchAll(/\P{Mark}\p{Mark}*|\p{Mark}+/gu), (match) => {
    const start = match.index;
    const value = match[0];
    return { text: value, normalized: value.normalize("NFC"), start, end: start + value.length };
  });
}

function mapMatchedCluster(
  offsets: Array<number | undefined>,
  bodyCluster: TextCluster,
  flatCluster: TextCluster,
): void {
  offsets[bodyCluster.start] = flatCluster.start;
  offsets[bodyCluster.end] = flatCluster.end;

  if (bodyCluster.text.length !== flatCluster.text.length) return;
  for (let offset = 1; offset < bodyCluster.text.length; offset += 1) {
    offsets[bodyCluster.start + offset] = flatCluster.start + offset;
  }
}

function mapSkippedCluster(
  offsets: Array<number | undefined>,
  bodyCluster: TextCluster,
  flatOffset: number,
): void {
  for (let offset = bodyCluster.start; offset <= bodyCluster.end; offset += 1) {
    offsets[offset] = flatOffset;
  }
}

function flatOffsetAt(
  flatClusters: readonly TextCluster[],
  flatIndex: number,
  endOffset: number,
): number {
  return flatClusters[flatIndex]?.start ?? endOffset;
}

function trimOneTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function notFound(message: string): FindResult {
  return { ok: false, code: "not_found", message };
}

function invalid(message: string): FindResult {
  return { ok: false, code: "invalid_write", message };
}
