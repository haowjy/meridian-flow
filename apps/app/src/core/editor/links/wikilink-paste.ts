/**
 * Pasted `[[Name]]` becomes a standard link (D15). Writers bring notes over
 * from note apps, whose links would otherwise arrive as dead brackets. Only
 * paste converts: a typed `[[`, what the AI writes, and text already stored
 * stay text.
 *
 * Wiki-style syntax: `[[target]]`, `[[target|label]]`, `[[target#Heading]]`,
 * `[[target#^block]]`, with folders in the target (`Arc 1/Kael`) and `.md`
 * implied when it names no extension. `![[…]]` is an embed and stays text
 * (there is no transclusion); `\[[` is escaped and stays the literal
 * brackets; code is never touched. Which pastes convert at all is the
 * policy's (`WikilinkPasteExtension`).
 *
 * A target resolves as note apps do, with a fixed order where theirs
 * last step is "the first one it finds" (`rankWikilinkMatches`). A match is
 * assigned its document's id (`doc:`), spelled with its full address; one that
 * names no document becomes the same dashed link the `@` menu's link-ahead row
 * writes, with a fresh ahead ref for the address that row's rule gives
 * (`linkAhead`), one per address per paste.
 */

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
  /** `#Heading` or `#^block`, kept on the destination; empty when none. */
  suffix: string;
  /** The alias, or the name without `.md`, as note apps show it. */
  label: string;
};

/** What converting a paste reads from the Editor that holds it. */
export type WikilinkPasteCatalog = {
  /** The holder's address; null while it has none. */
  holderUri: string | null;
  /** The documents a pasted link may name: the Editor's link index, in the areas a link names. */
  targets: readonly LinkAssignmentDocument[];
  /** Where a link to a document nobody has written goes (the link-ahead row's rule). */
  linkAhead: (name: string, folders: readonly string[]) => { uri: string } | null;
};

type PastedWikilink = WikilinkOccurrence | Extract<WikilinkSyntaxFinding, { kind: "escape" }>;

/** App resolution keeps its own filename/display policy; syntax belongs to markup. */
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

/**
 * The link each pasted `[[…]]` becomes: assigned the document it names, or
 * a fresh ahead ref at the link-ahead address when it names none; null leaves
 * it text. Built once per paste: the candidates are located once and bucketed
 * by filename, so a link only ranks the documents that share its name, and a
 * target seen twice is ranked once.
 */
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
  // Ranking ignores case, so its answer is cached under the lowercased path;
  // a link-ahead address keeps the writer's casing, so it is asked each time.
  const matches = new Map<string, Located | null>();
  // One address pasted twice shares one assignment, as in `assignPastedSlice`.
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

/**
 * The pasted slice with each convertible `[[…]]` as a link. Code (a fence or
 * a code mark) and text already inside a link are left as they are.
 */
export function linkPastedWikilinks(
  slice: Slice,
  schema: Schema,
  catalog: WikilinkPasteCatalog | null,
): Slice {
  const link = schema.marks.link;
  if (!link) return slice;
  // With no catalog yet, nothing links, but escapes are still spelled out.
  const resolve = catalog ? wikilinkResolver(catalog) : () => null;
  // A single projection carries comments across marks, paragraphs and nested blocks.
  // Code is opaque according to the editor schema, never guessed from its prose.
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
    // Existing links keep their characters. Escapes still spell out inside them.
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
