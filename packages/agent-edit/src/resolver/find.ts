import type { AgentEditCodec } from "../codec-adapter.js";
import type { BlockRef } from "../handles.js";
import type { FindSplice } from "../links/find-splice.js";
import { markdownPlainText, markdownTextView } from "../model/markdown-text-view.js";
import type { ProjectedBlock } from "../ports/model.js";
import type { BlockScope } from "./scope.js";

export interface FindContext {
  codec: AgentEditCodec;
  /** The one projection of the document being resolved against. */
  projected: readonly ProjectedBlock[];
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

function serializeScopeBlocks(ctx: FindContext, scope: BlockScope): SerializedBlockEntry[] {
  // A scope is a contiguous run of top-level blocks starting at `startIndex`.
  const selected = ctx.projected.slice(scope.startIndex, scope.startIndex + scope.blocks.length);
  const bodies = ctx.codec.serializeBlockBodies(selected.map((block) => block.node));
  let cursor = 0;
  return selected.map((block, bodyIndex) => {
    const body = bodies[bodyIndex] ?? "";
    const serialized = {
      block: block.ref,
      index: scope.startIndex + bodyIndex,
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
  /** Each match's splice in order: where it sits in the old group text and in `text`. */
  cuts: SpliceCut[];
}

export interface SpliceCut {
  old: { start: number; end: number };
  new: { start: number; end: number };
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
  let text = "";
  let cursor = 0;
  const cuts: SpliceCut[] = [];
  for (const match of matches) {
    const end = match.rangeStart + match.matchEnd - rangeStart;
    const start = command === "insert" ? end : match.rangeStart + match.matchStart - rangeStart;
    text += source.slice(cursor, start);
    cuts.push({
      old: { start, end },
      new: { start: text.length, end: text.length + content.length },
    });
    text += content;
    cursor = end;
  }
  text += source.slice(cursor);
  const first = cuts[0];
  const last = cuts.at(-1);
  // Text between several splices is inside the union too: the suffix after
  // the last splice is the only text that shifts.
  return {
    text,
    splice: {
      start: first?.old.start ?? source.length,
      oldEnd: last?.old.end ?? 0,
      newEnd: (last?.old.end ?? 0) + text.length - source.length,
    },
    cuts,
  };
}

export interface TextWindow {
  from: number;
  to: number;
}

const CUT_OPEN = "";
const CUT_CLOSE = "";

/**
 * Where each cut of `markdown` lands in the text of the blocks it parses to:
 * per block, the text windows the cuts cover. Found by parsing the markdown with
 * a private-use mark at each cut edge, so syntax never has to be mapped by hand.
 * Null when the marks changed the parse or landed outside text (a link target),
 * so the windows can't be trusted.
 */
export function cutTextWindows(
  ctx: Pick<FindContext, "codec">,
  markdown: string,
  cuts: readonly { start: number; end: number }[],
  blocks: readonly Parameters<AgentEditCodec["serialize"]>[0][number][],
): TextWindow[][] | null {
  let marked = "";
  let cursor = 0;
  for (const cut of cuts) {
    marked += `${markdown.slice(cursor, cut.start)}${CUT_OPEN}${markdown.slice(cut.start, cut.end)}${CUT_CLOSE}`;
    cursor = cut.end;
  }
  marked += markdown.slice(cursor);
  let parsed: ReturnType<AgentEditCodec["parse"]>["blocks"];
  try {
    parsed = ctx.codec.parse(marked).blocks;
  } catch {
    return null;
  }
  if (parsed.length !== blocks.length) return null;
  const windows: TextWindow[][] = [];
  let open: number | null = null;
  let closed = 0;
  for (const [index, block] of parsed.entries()) {
    let text = "";
    const blockWindows: TextWindow[] = [];
    if (open !== null) open = 0;
    for (const char of block.textContent) {
      if (char === CUT_OPEN) {
        if (open !== null) return null;
        open = text.length;
      } else if (char === CUT_CLOSE) {
        if (open === null) return null;
        blockWindows.push({ from: open, to: text.length });
        open = null;
        closed += 1;
      } else text += char;
    }
    if (open !== null) blockWindows.push({ from: open, to: text.length });
    const real = blocks[index]?.textContent;
    if (text === real) {
      windows.push(blockWindows);
      continue;
    }
    // A mark at the block's edge keeps whitespace the real parse trims there.
    // Clamp the windows to the trimmed text; when that whitespace sat outside
    // them, the text around the windows no longer matches and the caller drops them.
    const lead = text.length - text.trimStart().length;
    if (text.trim() !== real) return null;
    const clamp = (at: number) => Math.min(Math.max(at - lead, 0), real.length);
    windows.push(
      blockWindows.map((window) => ({ from: clamp(window.from), to: clamp(window.to) })),
    );
  }
  return open === null && closed === cuts.length ? windows : null;
}
