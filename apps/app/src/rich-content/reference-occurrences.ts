/** Exact source authority for static user-turn references and skill presentation. */
import type { PresentationSourceRun } from "@meridian/markup";
import { decodeString } from "micromark-util-decode-string";

export type MarkdownReferenceOccurrence = {
  from: number;
  to: number;
  documentId: string;
  uri: string;
};
export type MarkdownSkillOccurrence = {
  from: number;
  to: number;
  slug: string;
  name: string;
  description: string;
};

export function boundedRanges<T extends { from: number; to: number }>(
  items: readonly T[],
  sourceLength: number,
): T[] {
  let end = 0;
  return [...items]
    .sort((a, b) => a.from - b.from)
    .filter((item) => {
      if (
        !Number.isInteger(item.from) ||
        !Number.isInteger(item.to) ||
        item.from < end ||
        item.to <= item.from ||
        item.to > sourceLength
      )
        return false;
      end = item.to;
      return true;
    });
}

export function referenceForRun(
  run: PresentationSourceRun | undefined,
  references: readonly MarkdownReferenceOccurrence[],
): MarkdownReferenceOccurrence | undefined {
  return run?.kind === "link" && run.source
    ? references.find((item) => item.from === run.source?.from && item.to === run.source?.to)
    : undefined;
}

export function skillsForRun(
  run: PresentationSourceRun | undefined,
  source: string,
  skills: readonly MarkdownSkillOccurrence[],
): { from: number; to: number; skill: MarkdownSkillOccurrence }[] {
  if (run?.kind !== "text" || !run.source) return [];
  const range = run.source;
  const length = decodeString(source.slice(range.from, range.to)).length;
  // Decode from the end: a preceding backslash can escape the token's slash,
  // so a prefix ending at that boundary is not independently decodable.
  const offset = (at: number) =>
    (run.at.offset ?? 0) + length - decodeString(source.slice(at, range.to)).length;
  return skills
    .filter(
      (item) =>
        item.from >= range.from &&
        item.to <= range.to &&
        source.slice(item.from, item.to) === `/${item.slug}`,
    )
    .map((skill) => ({
      from: offset(skill.from),
      to: offset(skill.to),
      skill,
    }));
}

export function skillsForRuns(
  runs: readonly PresentationSourceRun[] | undefined,
  source: string,
  skills: readonly MarkdownSkillOccurrence[],
) {
  return (runs ?? []).flatMap((run) => skillsForRun(run, source, skills));
}
