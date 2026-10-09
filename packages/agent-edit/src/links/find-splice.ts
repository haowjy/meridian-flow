/**
 * Restoring link identity outside a find splice (contract §5.4).
 *
 * The formatted find path splices written Markdown into the serialized block
 * group and reparses the whole group, which rebuilds every link in the group
 * from text. Occurrences entirely before or after the splice are the ones the
 * write did not touch: each takes its old twin's attrs verbatim. Only the
 * occurrences inside the splice go through ref assignment.
 */
import type { ParsedContentWithSpans, PMNode } from "@meridian/markup";
import type { LinkOccurrence } from "@meridian/markup/links";
import { walkLinkOccurrences } from "@meridian/markup/links";
import type { OccurrenceAttrs } from "./occurrences.js";
import { rebuildOccurrences } from "./occurrences.js";

export interface FindSplice {
  /** Offset in both texts where the splice starts. */
  start: number;
  /** End of the replaced text in the old group text. */
  oldEnd: number;
  /** End of the written text in the new group text. */
  newEnd: number;
}

export interface SpliceRestoreInput {
  /** The group's current nodes, carrying stored attrs. */
  oldGroup: readonly PMNode[];
  /** The exact serialized group the splice was applied to. */
  oldText: string;
  /** `oldText` reparsed: each old occurrence's source span. */
  oldSpans: ParsedContentWithSpans["spans"];
  /** The group text after the splice. */
  newText: string;
  /** `newText` parsed with spans. */
  parsed: ParsedContentWithSpans;
  splice: FindSplice;
  /** Ref assignment for the inside occurrences, index-aligned with `written`. */
  assignOccurrences(
    old: readonly LinkOccurrence[],
    written: readonly LinkOccurrence[],
  ): OccurrenceAttrs[];
}

/** Why the splice could not be restored precisely; the caller assigns the whole group. */
export type SpliceFallback = "misaligned" | "coarse-spans" | "surroundings-reparsed";

/**
 * The new group's nodes with outside occurrences restored and inside ones
 * assigned, or a fallback reason when the outside cannot be told apart: the
 * splice changed how the surrounding syntax parses (prefix or suffix counts
 * differ), or ingress rewrote the text so every span is the whole text.
 */
export function restoreOutsideSplice(
  input: SpliceRestoreInput,
): { nodes: PMNode[] } | { fallback: SpliceFallback } {
  const { splice } = input;
  const oldOccurrences = walkLinkOccurrences(input.oldGroup);
  const { oldSpans, parsed } = input;
  const { newText } = input;
  const blocks = parsed.blocks;
  const newOccurrences = walkLinkOccurrences(blocks);
  // The serialized old group must reparse into the same occurrences, or its spans name nothing.
  if (oldSpans.length !== oldOccurrences.length || parsed.spans.length !== newOccurrences.length)
    return { fallback: "misaligned" };
  if (coarse(oldSpans, input.oldText) || coarse(parsed.spans, newText))
    return { fallback: "coarse-spans" };

  const oldPrefix = countWhile(oldSpans, (span) => span.end <= splice.start);
  const newPrefix = countWhile(parsed.spans, (span) => span.end <= splice.start);
  const oldSuffix = countFromEnd(oldSpans, (span) => span.start >= splice.oldEnd);
  const newSuffix = countFromEnd(parsed.spans, (span) => span.start >= splice.newEnd);
  if (
    oldPrefix !== newPrefix ||
    oldSuffix !== newSuffix ||
    oldPrefix + oldSuffix > oldOccurrences.length ||
    newPrefix + newSuffix > newOccurrences.length
  )
    return { fallback: "surroundings-reparsed" };

  const attrs: (OccurrenceAttrs | null)[] = newOccurrences.map(() => null);
  const twins: Array<[LinkOccurrence | undefined, number]> = [];
  for (let index = 0; index < newPrefix; index += 1) twins.push([oldOccurrences[index], index]);
  for (let offset = 1; offset <= newSuffix; offset += 1)
    twins.push([oldOccurrences[oldOccurrences.length - offset], newOccurrences.length - offset]);
  for (const [old, index] of twins) {
    const next = newOccurrences[index];
    // Outside text is byte-identical, so a kind mismatch means the parse realigned.
    if (!old || !next || old.kind !== next.kind) return { fallback: "surroundings-reparsed" };
    attrs[index] = old.attrs;
  }
  const insideOld = oldOccurrences.slice(oldPrefix, oldOccurrences.length - oldSuffix);
  const insideWritten = newOccurrences.slice(newPrefix, newOccurrences.length - newSuffix);
  const assigned = input.assignOccurrences(insideOld, insideWritten);
  assigned.forEach((value, offset) => {
    attrs[newPrefix + offset] = value;
  });
  return { nodes: rebuildOccurrences(blocks, newOccurrences, attrs) };
}

/**
 * Ingress rewrote the text, so every span is the whole text and none tells
 * the outside apart (a lone link that is the whole text is assigned the same way
 * either path).
 */
function coarse(spans: readonly { start: number; end: number }[], text: string): boolean {
  return spans.length > 0 && spans.every((span) => span.start === 0 && span.end === text.length);
}

function countWhile<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  while (count < items.length && predicate(items[count] as T)) count += 1;
  return count;
}

function countFromEnd<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  while (count < items.length && predicate(items[items.length - 1 - count] as T)) count += 1;
  return count;
}
