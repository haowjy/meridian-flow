import {
  type AheadRef,
  aheadAddress,
  documentRef,
  mintAheadRef,
  storedHref,
} from "@meridian/contracts";
import {
  type Located,
  locate,
  rankWikilinkMatches,
  scanWikilinks,
  storedName,
  type WikilinkSyntaxFinding,
  type WikilinkTarget,
  wantedPath,
} from "@meridian/markup/wikilinks";
import { Fragment, type MarkType, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";

import type { AssignedLink, LinkAssignmentDocument } from "./link-assignment";

type WikilinkOccurrence = {
  from: number;
  to: number;
  target: WikilinkTarget;
  suffix: string;
  label: string;
};

export type WikilinkPasteCatalog = {
  holderUri: string | null;
  targets: readonly LinkAssignmentDocument[];
  linkAhead: (name: string, folders: readonly string[]) => { uri: string } | null;
};

type PastedWikilink = WikilinkOccurrence | Extract<WikilinkSyntaxFinding, { kind: "escape" }>;

function pastedWikilinks(text: string): PastedWikilink[] {
  return scanWikilinks(text, { context: "prose" }).findings.flatMap<PastedWikilink>((finding) => {
    if (finding.kind === "escape") return [finding];
    if (finding.kind !== "wikilink" || finding.embed) return [];
    const segments = finding.linkpath.split("/").map((segment) => segment.trim());
    const name = segments.pop() ?? "";
    if (!name || segments.some((segment) => !segment)) return [];
    return [
      {
        from: finding.from,
        to: finding.to,
        target: { folders: segments, name },
        suffix:
          finding.block !== null
            ? `#^${finding.block}`
            : finding.heading !== null
              ? `#${finding.heading}`
              : "",
        label: finding.label || storedName(name),
      },
    ];
  });
}

function wikilinkResolver(
  catalog: WikilinkPasteCatalog,
): (occurrence: WikilinkOccurrence) => AssignedLink | null {
  const byName = new Map<string, Located[]>();
  for (const { documentId, uri } of catalog.targets) {
    const located = locate(uri, documentId);
    const name = located?.segments.at(-1);
    if (!located || name === undefined) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push(located);
    else byName.set(name, [located]);
  }
  const holder = catalog.holderUri ? locate(catalog.holderUri, null) : null;
  const matches = new Map<string, Located | null>();
  const aheadRefs = new Map<string, AheadRef>();
  return (occurrence) => {
    const { target } = occurrence;
    const wanted = wantedPath(target);
    const key = wanted.join("/");
    let match = matches.get(key);
    if (match === undefined) {
      match = rankWikilinkMatches(byName.get(wanted.at(-1) ?? "") ?? [], target, holder);
      matches.set(key, match);
    }
    if (match?.documentId)
      return {
        ref: documentRef(match.documentId),
        href: storedHref({ kind: "document", uri: match.uri }, occurrence.suffix),
      };
    const ahead = catalog.linkAhead(target.name, target.folders)?.uri;
    const address = ahead ? aheadAddress(ahead, "link") : null;
    if (!address) return null;
    let ref = aheadRefs.get(address);
    if (!ref) {
      ref = mintAheadRef();
      aheadRefs.set(address, ref);
    }
    return { ref, href: storedHref({ kind: "document", uri: address }, occurrence.suffix) };
  };
}

export function linkPastedWikilinks(
  slice: Slice,
  schema: Schema,
  catalog: WikilinkPasteCatalog | null,
): Slice {
  const link = schema.marks.link;
  if (!link) return slice;
  const resolve = catalog ? wikilinkResolver(catalog) : () => null;
  let text = "";
  const starts = new Map<number, number>();
  const opaqueRanges: { from: number; to: number }[] = [];
  const existingLinks: { from: number; to: number }[] = [];
  const project = (fragment: Fragment, base: number): void => {
    fragment.forEach((node, offset) => {
      const pos = base + offset;
      if (node.type.spec.code) {
        const from = text.length;
        text += "\n\nx\n\n";
        opaqueRanges.push({ from, to: text.length });
      } else if (node.isText) {
        starts.set(pos, text.length);
        if (node.marks.some((mark) => mark.type.name === "link"))
          existingLinks.push({ from: text.length, to: text.length + (node.text?.length ?? 0) });
        const code = node.marks.some((mark) => mark.type.spec.code);
        if (code)
          opaqueRanges.push({ from: text.length, to: text.length + (node.text?.length ?? 0) });
        text += code ? "x".repeat(node.text?.length ?? 0) : node.text;
      } else if (node.isLeaf) {
        const from = text.length;
        text += node.type.name === "hardBreak" ? "\n" : "\uFFFC";
        opaqueRanges.push({ from, to: text.length });
      } else {
        if (node.isBlock) text += "\n\n";
        project(node.content, pos + 1);
        if (node.isBlock) text += "\n\n";
      }
    });
  };
  project(slice.content, 0);
  const occurrences = pastedWikilinks(text).filter(
    (occurrence) =>
      !opaqueRanges.some((span) => occurrence.from < span.to && occurrence.to > span.from),
  );
  const replacements = occurrences.flatMap<Replacement>((occurrence) => {
    if ("literal" in occurrence)
      return [
        { from: occurrence.from, to: occurrence.to, text: occurrence.literal, assigned: null },
      ];
    if (existingLinks.some((span) => occurrence.from < span.to && occurrence.to > span.from))
      return [];
    const assigned = resolve(occurrence);
    return assigned
      ? [{ from: occurrence.from, to: occurrence.to, text: occurrence.label, assigned }]
      : [];
  });
  const convert = (fragment: Fragment, base: number): Fragment => {
    let changed = false;
    const nodes: PMNode[] = [];
    fragment.forEach((node, offset) => {
      const pos = base + offset;
      if (node.type.spec.code) {
        nodes.push(node);
        return;
      }
      if (!node.isText) {
        const content = convert(node.content, pos + 1);
        if (content !== node.content) changed = true;
        nodes.push(content === node.content ? node : node.copy(content));
        return;
      }
      const start = starts.get(pos);
      const linked = start === undefined ? [node] : replaceText(node, start, replacements, link);
      if (linked.length !== 1 || linked[0] !== node) changed = true;
      nodes.push(...linked);
    });
    return changed ? Fragment.fromArray(nodes) : fragment;
  };
  const content = convert(slice.content, 0);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

type Replacement = {
  from: number;
  to: number;
  text: string;
  assigned: AssignedLink | null;
};

function replaceText(
  node: PMNode,
  start: number,
  replacements: readonly Replacement[],
  link: MarkType,
): PMNode[] {
  const text = node.text ?? "";
  if (node.marks.some((mark) => mark.type.spec.code)) return [node];
  const linked = node.marks.some((mark) => mark.type.name === "link");
  const pieces: PMNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const replacement of replacements) {
    if (replacement.to <= start || replacement.from >= start + text.length) continue;
    if (linked && replacement.assigned) continue;
    const from = Math.max(0, replacement.from - start);
    const to = Math.min(text.length, replacement.to - start);
    if (from > cursor) pieces.push(node.type.schema.text(text.slice(cursor, from), node.marks));
    if (replacement.from >= start) {
      const marks = replacement.assigned
        ? link.create({ ...replacement.assigned, title: null }).addToSet(node.marks)
        : node.marks;
      pieces.push(node.type.schema.text(replacement.text, marks));
    }
    cursor = to;
    changed = true;
  }
  if (!changed) return [node];
  if (cursor < text.length) pieces.push(node.type.schema.text(text.slice(cursor), node.marks));
  return pieces;
}
