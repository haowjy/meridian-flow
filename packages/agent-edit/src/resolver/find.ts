import type { AgentEditCodec } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { FindSplice } from "../links/find-splice.js";
import { markdownPlainText, markdownTextView } from "../model/markdown-text-view.js";
import type { AgentEditModel } from "../ports/model.js";
import type { BlockScope } from "./scope.js";

export interface FindContext {
  doc: DocHandle;
  model: AgentEditModel;
  codec: AgentEditCodec;
}

export interface FindMatch {
  elements: BlockRef[];
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
  block: BlockRef;
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
  return matchSerializedText(entries, haystack, find, all);
}

function matchSerializedText(
  entries: SerializedBlockEntry[],
  haystack: string,
  find: string,
  all: boolean,
): FindResult {
  const view = markdownTextView(haystack);
  const needle = markdownPlainText(find);
  const matches = nonOverlappingMatches(view.text, needle).map((match) => ({
    start: view.start[match.start],
    end: view.end[match.end - 1],
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

export function serializeBlockBody(ctx: FindContext, block: BlockRef): string {
  return ctx.model.serializeBlockBodies(ctx.doc, ctx.codec, [block])[0] ?? "";
}

export function serializePmBlockBody(
  ctx: Pick<FindContext, "codec">,
  block: Parameters<AgentEditCodec["serialize"]>[0][number],
): string {
  return ctx.codec.serializeBlockBodies([block])[0] ?? "";
}

export function serializeScopeBlocks(ctx: FindContext, scope: BlockScope): SerializedBlockEntry[] {
  const allBlocks = ctx.model.getBlocks(ctx.doc);
  const indexByBlock = new Map<BlockRef, number>();
  allBlocks.forEach((block, index) => {
    indexByBlock.set(block, index);
  });
  const selected = scope.blocks
    .map((block) => ({ block, index: indexByBlock.get(block) }))
    .filter((entry): entry is { block: BlockRef; index: number } => entry.index !== undefined);
  const bodies = ctx.model.serializeBlockBodies(
    ctx.doc,
    ctx.codec,
    selected.map((entry) => entry.block),
  );
  let cursor = 0;
  return selected.map((entry, bodyIndex) => {
    const body = bodies[bodyIndex] ?? "";
    const serialized = {
      block: entry.block,
      index: entry.index,
      body,
      start: cursor,
      end: cursor + body.length,
    };
    cursor = serialized.end + (bodyIndex === selected.length - 1 ? 0 : 2);
    return serialized;
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

/** The spliced group text and the one span covering every splice in it. */
export interface SplicedGroup {
  text: string;
  splice: FindSplice;
}

/**
 * Splice the written content into a serialized group at every match: the
 * pre-splice text is `source`, and `splice` gives the offsets ref assignment
 * restores around (§5.4).
 */
export function spliceFindMatches(
  source: string,
  matches: readonly TextFindMatch[],
  rangeStart: number,
  content: string,
  command: "insert" | "replace" | "remove",
): SplicedGroup {
  let result = source;
  let start = source.length;
  let oldEnd = 0;
  for (const match of [...matches].reverse()) {
    const matchStart = match.rangeStart + match.matchStart - rangeStart;
    const end = match.rangeStart + match.matchEnd - rangeStart;
    const spliceStart = command === "insert" ? end : matchStart;
    result = result.slice(0, spliceStart) + content + result.slice(end);
    start = Math.min(start, spliceStart);
    oldEnd = Math.max(oldEnd, end);
  }
  // Text between several splices is inside the union too: the suffix after
  // the last splice is the only text that shifts.
  return {
    text: result,
    splice: { start, oldEnd, newEnd: oldEnd + result.length - source.length },
  };
}
