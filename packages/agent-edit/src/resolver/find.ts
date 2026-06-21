import type * as Y from "yjs";

import type { Codec } from "../codec/types.js";
import type { YProsemirrorDocumentModel } from "../model/y-prosemirror.js";
import type { BlockScope } from "./scope.js";

const EMPTY_PARAGRAPH_SENTINEL = "\u00a0";

export interface FindContext {
  doc: Y.Doc;
  model: YProsemirrorDocumentModel;
  codec: Codec;
}

export interface FindMatch {
  element: Y.XmlElement;
  span: { start: number; end: number };
  absoluteStart: number;
  absoluteEnd: number;
}

export type FindResult =
  | { ok: true; matches: FindMatch[] }
  | {
      ok: false;
      code: "not_found" | "ambiguous_match" | "invalid_write";
      message: string;
      count?: number;
    };

interface SerializedBlockEntry {
  block: Y.XmlElement;
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
    return invalid(
      "Cross-block find matches are not supported by this resolver implementation yet",
    );
  }
  return { ok: true, matches: resolved.filter((match): match is FindMatch => match !== null) };
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
): FindMatch | null {
  const entry = entries.find((candidate) => start >= candidate.start && end <= candidate.end);
  if (!entry) return null;
  const localStart = start - entry.start;
  const localEnd = end - entry.start;
  const span = serializedOffsetsToFlatSpan(entry, localStart, localEnd);
  if (!span) return null;
  return { element: entry.block, span, absoluteStart: start, absoluteEnd: end };
}

function serializedOffsetsToFlatSpan(
  entry: SerializedBlockEntry,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (entry.body === entry.flatText) return { start, end };
  const matched = entry.body.slice(start, end).normalize("NFC");
  const flat = entry.flatText.normalize("NFC");
  const flatStart = flat.indexOf(matched);
  if (flatStart < 0) return null;
  if (flat.indexOf(matched, flatStart + Math.max(matched.length, 1)) >= 0) return null;
  return { start: flatStart, end: flatStart + matched.length };
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
