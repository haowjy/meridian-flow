/** Project original-source authority onto parsed inline references, never onto code or title matches. Skill `/slug` ranges split the same text nodes; they are not wikilinks. */
import { formatWikilink } from "@meridian/markup";
import { decodeString } from "micromark-util-decode-string";
import { classifyLinkTarget } from "@/core/editor/links";

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
export const REFERENCE_TAG = "meridian-reference";
export const SKILL_TAG = "meridian-skill";
type Node = {
  type: string;
  value?: string;
  url?: string;
  target?: string;
  label?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, string> };
};

function boundedRanges<T extends { from: number; to: number }>(
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

/** Named plugin + JSON options keep Streamdown's processor cache authority-specific. */
export function remarkReferenceOccurrences({
  occurrences,
  skills = [],
}: {
  occurrences: readonly MarkdownReferenceOccurrence[];
  skills?: readonly MarkdownSkillOccurrence[];
}) {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value);
    transform(
      tree,
      boundedRanges(occurrences, source.length),
      boundedRanges(skills, source.length).filter(
        (item) => source.slice(item.from, item.to) === `/${item.slug}`,
      ),
      source,
    );
  };
}

function presentation(
  node: Node,
  occurrence?: MarkdownReferenceOccurrence,
  authoredLabel = false,
): void {
  node.data = occurrence
    ? {
        hName: REFERENCE_TAG,
        hProperties: { dataDocumentId: occurrence.documentId, dataUri: occurrence.uri },
      }
    : {
        hName: REFERENCE_TAG,
        hProperties: {
          dataTargetHref: node.target ? formatWikilink(node.target) : (node.url ?? ""),
        },
      };
  if (node.label !== undefined || node.type === "wikiLinkResource" || authoredLabel) {
    node.data.hProperties = { ...node.data.hProperties, dataAuthoredLabel: "true" };
  }
  // A standard link handler would otherwise emit its href around the custom control.
  if (node.type === "link") node.type = "referenceLabel";
}

function skillPresentation(node: Node, skill: MarkdownSkillOccurrence): void {
  node.data = {
    hName: SKILL_TAG,
    hProperties: {
      dataSlug: skill.slug,
      dataName: skill.name,
      dataDescription: skill.description,
    },
  };
}

type TextRange =
  | { kind: "reference"; from: number; to: number; item: MarkdownReferenceOccurrence }
  | { kind: "skill"; from: number; to: number; item: MarkdownSkillOccurrence };

function transform(
  node: Node,
  occurrences: readonly MarkdownReferenceOccurrence[],
  skills: readonly MarkdownSkillOccurrence[],
  source: string,
): boolean {
  if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return false;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const exact = occurrences.find((item) => item.from === start && item.to === end);
  if (node.type === "wikiLink" || node.type === "wikiLinkResource") {
    presentation(node, exact);
    return true;
  }
  const target = node.type === "link" && node.url ? classifyLinkTarget(node.url) : null;
  if (target && target.kind !== "external") {
    const authoredLabel = typeof start === "number" && source[start] === "[";
    const defaultUriLabel =
      !authoredLabel &&
      target.kind === "scheme" &&
      node.children?.length === 1 &&
      node.children[0]?.value === node.url;
    presentation(node, exact, authoredLabel);
    if (defaultUriLabel && node.children?.[0] && target.kind === "scheme") {
      node.children[0].value = target.uri.split("/").at(-1) || target.uri;
    }
    if (exact) return true;
  }
  if (!node.children) return Boolean(target && target.kind !== "external");
  let authorized = false;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (!child) continue;
    if (
      child.type !== "text" ||
      child.value === undefined ||
      child.position?.start.offset === undefined ||
      child.position.end.offset === undefined
    ) {
      authorized = transform(child, occurrences, skills, source) || authorized;
      continue;
    }
    const start = child.position.start.offset;
    const end = child.position.end.offset;
    // Only literal canonical URIs use text splitting. Wikilinks belong to the parser above.
    const within: TextRange[] = [
      ...occurrences
        .filter(
          (item) =>
            item.from >= start &&
            item.to <= end &&
            source.slice(item.from, item.to) === item.uri &&
            classifyLinkTarget(item.uri)?.kind === "scheme",
        )
        .map((item) => ({ kind: "reference" as const, from: item.from, to: item.to, item })),
      ...skills
        .filter((item) => item.from >= start && item.to <= end)
        .map((item) => ({ kind: "skill" as const, from: item.from, to: item.to, item })),
    ].sort((a, b) => a.from - b.from);
    if (!within.length) continue;
    const split: Node[] = [];
    let cursor = 0;
    let lastEnd = start;
    for (const range of within) {
      if (range.from < lastEnd) continue;
      lastEnd = range.to;
      const from = decodeString(source.slice(start, range.from)).length;
      const to = decodeString(source.slice(start, range.to)).length;
      if (from > cursor) split.push({ type: "text", value: child.value.slice(cursor, from) });
      if (range.kind === "reference") {
        const reference: Node = {
          type: "referenceLabel",
          children: [{ type: "text", value: range.item.uri.split("/").at(-1) || range.item.uri }],
        };
        presentation(reference, range.item);
        split.push(reference);
      } else {
        const skill: Node = {
          type: "skillLabel",
          children: [{ type: "text", value: child.value.slice(from, to) }],
        };
        skillPresentation(skill, range.item);
        split.push(skill);
      }
      cursor = to;
    }
    if (cursor < child.value.length) split.push({ type: "text", value: child.value.slice(cursor) });
    node.children.splice(index, 1, ...split);
    index += split.length - 1;
    authorized = true;
  }
  if (authorized && (node.type === "link" || node.type === "referenceLabel")) {
    node.type = "referenceLabel";
    node.data = { hName: "span" };
  }
  return authorized || Boolean(target && target.kind !== "external");
}
