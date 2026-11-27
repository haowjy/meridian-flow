import type { ParsedContentWithSpans, PMNode } from "@meridian/markup";
import type { LinkOccurrence } from "@meridian/markup/links";
import { walkLinkOccurrences } from "@meridian/markup/links";
import type { OccurrenceAttrs } from "./occurrences.js";
import { rebuildOccurrences } from "./occurrences.js";

export interface FindSplice {
  start: number;
  oldEnd: number;
  newEnd: number;
}

export interface SpliceRestoreInput {
  oldGroup: readonly PMNode[];
  oldText: string;
  oldSpans: ParsedContentWithSpans["spans"];
  newText: string;
  parsed: ParsedContentWithSpans;
  splice: FindSplice;
  assignOccurrences(
    old: readonly LinkOccurrence[],
    written: readonly LinkOccurrence[],
  ): OccurrenceAttrs[];
}

export type SpliceFallback = "misaligned" | "coarse-spans" | "surroundings-reparsed";

export function restoreOutsideSplice(
  input: SpliceRestoreInput,
): { nodes: PMNode[] } | { fallback: SpliceFallback } {
  const { splice } = input;
  const oldOccurrences = walkLinkOccurrences(input.oldGroup);
  const { oldSpans, parsed } = input;
  const { newText } = input;
  const blocks = parsed.blocks;
  const newOccurrences = walkLinkOccurrences(blocks);
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
