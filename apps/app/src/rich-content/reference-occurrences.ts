/** Exact source authority for static user-turn references and skill presentation. */
import { type PresentationSourceRun, presentationTextRange } from "@meridian/markup";

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

function skillsForRun(
  run: PresentationSourceRun | undefined,
  source: string,
  skills: readonly MarkdownSkillOccurrence[],
): { from: number; to: number; skill: MarkdownSkillOccurrence }[] {
  if (run?.kind !== "text" || !run.source) return [];
  const range = run.source;
  return skills
    .filter(
      (item) =>
        item.from >= range.from &&
        item.to <= range.to &&
        source.slice(item.from, item.to) === `/${item.slug}`,
    )
    .flatMap((skill) => {
      const resolved = presentationTextRange(run, source, skill);
      return resolved ? [{ ...resolved, skill }] : [];
    });
}

export function skillsForRuns(
  runs: readonly PresentationSourceRun[] | undefined,
  source: string,
  skills: readonly MarkdownSkillOccurrence[],
) {
  return (runs ?? []).flatMap((run) => skillsForRun(run, source, skills));
}
