import type * as Y from "yjs";

import type { Codec } from "../codec/types.js";
import { projectDocumentBlocks } from "../model/block-projection.js";
import type { AgentEditModel } from "../ports/model.js";
import type { BlockScope } from "./scope.js";

export interface FindContext {
  doc: Y.Doc;
  model: AgentEditModel;
  codec: Codec;
}

export interface FindMatch {
  elements: Y.XmlElement[];
  startIndex: number;
  endIndex: number;
  rangeSource: string;
  rangeStart: number;
  matchStart: number;
  matchEnd: number;
}

export type TextFindMatch = FindMatch;

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
    return invalid("Could not map find match to editable block range");
  }
  return {
    ok: true,
    matches: resolved.filter((match): match is TextFindMatch => match !== null),
  };
}

export function serializeBlockBody(ctx: FindContext, block: Y.XmlElement): string {
  const pmBlock = ctx.model.toProsemirrorBlock(ctx.doc, block);
  return ctx.codec.serializeBlockBodies([pmBlock])[0] ?? "";
}

export function serializePmBlockBody(
  ctx: Pick<FindContext, "codec">,
  block: Parameters<Codec["serialize"]>[0][number],
): string {
  return ctx.codec.serializeBlockBodies([block])[0] ?? "";
}

export function serializeScopeBlocks(ctx: FindContext, scope: BlockScope): SerializedBlockEntry[] {
  const selected = projectDocumentBlocks(ctx.doc, ctx.model).select(scope.blocks);
  const bodies = ctx.codec.serializeBlockBodies(selected.map((block) => block.pmBlock));
  let cursor = 0;
  return selected.map((block, index) => {
    const body = bodies[index] ?? "";
    const entry = {
      block: block.block,
      index: block.index,
      body,
      start: cursor,
      end: cursor + body.length,
    };
    cursor = entry.end + (index === selected.length - 1 ? 0 : 2);
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
  return resolveRangeMatch(entries.slice(firstIndex, lastIndex + 1), start, end);
}

function resolveRangeMatch(
  entries: readonly SerializedBlockEntry[],
  start: number,
  end: number,
): TextFindMatch | null {
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last) return null;
  const rangeSource = entries.map((entry) => entry.body).join("\n\n");
  const matchStart = start - first.start;
  const matchEnd = end - first.start;
  if (matchStart < 0 || matchEnd < matchStart || matchEnd > rangeSource.length) return null;

  return {
    elements: entries.map((entry) => entry.block),
    startIndex: first.index,
    endIndex: last.index,
    rangeSource,
    rangeStart: first.start,
    matchStart,
    matchEnd,
  };
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function notFound(message: string): FindResult {
  return { ok: false, code: "not_found", message };
}

function invalid(message: string): FindResult {
  return { ok: false, code: "invalid_write", message };
}
