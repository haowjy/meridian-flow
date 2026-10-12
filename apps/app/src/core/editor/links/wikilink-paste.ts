/**
 * Pasted `[[Name]]` becomes a standard link (D15). Writers bring notes over
 * from Obsidian, whose links would otherwise arrive as dead brackets. Only
 * paste converts: a typed `[[`, what the AI writes, and text already stored
 * stay text.
 *
 * Obsidian's syntax: `[[target]]`, `[[target|label]]`, `[[target#Heading]]`,
 * `[[target#^block]]`, with folders in the target (`Arc 1/Kael`) and `.md`
 * implied when it names no extension. `![[…]]` is an embed and stays text
 * (there is no transclusion); `\[[` is escaped and stays the literal
 * brackets; code is never touched. Which pastes convert at all is the
 * policy's (`WikilinkPasteExtension`).
 *
 * A target resolves as Obsidian's does, with a fixed order where Obsidian's
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
  parseContextUri,
  storedHref,
} from "@meridian/contracts";
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
import { type ObsidianFinding, scanObsidian } from "@meridian/markup/obsidian";
import { Fragment, type MarkType, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";

import type { AssignedLink, LinkAssignmentDocument } from "./link-assignment";

type WikilinkTarget = {
  /** Folders before the name, as written (`["Arc 1"]` for `Arc 1/Kael`). */
  folders: readonly string[];
  /** The last segment, as written. */
  name: string;
};

type WikilinkOccurrence = {
  from: number;
  to: number;
  target: WikilinkTarget;
  /** `#Heading` or `#^block`, kept on the destination; empty when none. */
  suffix: string;
  /** The alias, or the name without `.md`, as Obsidian shows it. */
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

type PastedWikilink = WikilinkOccurrence | Extract<ObsidianFinding, { kind: "escape" }>;

/** App resolution keeps its own filename/display policy; syntax belongs to markup. */
function pastedWikilinks(text: string): PastedWikilink[] {
  return scanObsidian(text, { context: "prose" }).findings.flatMap<PastedWikilink>((finding) => {
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

type Located = {
  uri: string;
  documentId: string | null;
  area: string;
  scheme: string;
  segments: string[];
};

/** Fixed order for an exact path in another area; the holder's own area is first. */
const AREA_ORDER = ["manuscript", "kb", "user", "scratch"];

/**
 * Which candidate a target names, of those whose path ends with it. The
 * project has several areas where Obsidian has one vault, and Obsidian's last
 * step is index order, so ours is fixed. `holder` is the document the paste
 * lands in, or null when it has no address yet.
 *
 * - `[[Name]]`: the holder's own folder, then the holder's area root, then
 *   the rest (holder's area first, fewest folders, alphabetical URI).
 * - `[[a/Name]]`: that path from the holder's area root, then from another
 *   area's root (Manuscript, KB, User, Scratch), then the rest as above.
 *
 * Comparisons ignore case. Null only when nothing matches.
 */
function rankWikilinkMatches(
  candidates: readonly Located[],
  target: WikilinkTarget,
  holder: Located | null,
): Located | null {
  const wanted = wantedPath(target);
  const matches = candidates.filter((candidate) => endsWith(candidate.segments, wanted));
  if (!matches.length) return null;
  const inHolderArea = (candidate: Located) => candidate.area === holder?.area;
  const isPath = (candidate: Located, path: readonly string[]) =>
    candidate.segments.length === path.length && endsWith(candidate.segments, path);

  const preferred: ((candidate: Located) => boolean)[] = target.folders.length
    ? [
        (candidate) => inHolderArea(candidate) && isPath(candidate, wanted),
        ...AREA_ORDER.map(
          (scheme) => (candidate: Located) =>
            !inHolderArea(candidate) && candidate.scheme === scheme && isPath(candidate, wanted),
        ),
      ]
    : holder
      ? [
          (candidate) =>
            inHolderArea(candidate) &&
            isPath(candidate, [...holder.segments.slice(0, -1), ...wanted]),
          (candidate) => inHolderArea(candidate) && isPath(candidate, wanted),
        ]
      : [];
  for (const prefer of preferred) {
    const hit = matches.find(prefer);
    if (hit) return hit;
  }
  const [first] = [...matches].sort(
    (left, right) =>
      Number(inHolderArea(right)) - Number(inHolderArea(left)) ||
      left.segments.length - right.segments.length ||
      (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0),
  );
  return first ?? null;
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
        href: storedHref(match.uri, occurrence.suffix),
      };
    const ahead = catalog.linkAhead(target.name, target.folders)?.uri;
    const address = ahead ? aheadAddress(ahead, "link") : null;
    if (!address) return null;
    let ref = aheadRefs.get(address);
    if (!ref) {
      ref = mintAheadRef();
      aheadRefs.set(address, ref);
    }
    return { ref, href: storedHref(address, occurrence.suffix) };
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

function locate(uri: string, documentId: string | null): Located | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok || !parsed.value.path) return null;
  return {
    uri,
    documentId,
    area: `${parsed.value.scheme} ${JSON.stringify(parsed.value.authority)}`,
    scheme: parsed.value.scheme,
    segments: parsed.value.path.split("/").map(lower),
  };
}

/** The lowercased path a target's candidates end with: the last name as stored. */
function wantedPath(target: WikilinkTarget): string[] {
  return [...target.folders, storedName(target.name)].map(lower);
}

/** What a written name is stored as: `Chapter 13.md` is `Chapter 13`, `outline.json` stays. */
function storedName(name: string): string {
  const parsed = parseDocumentFilename(name);
  return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : name;
}

function endsWith(segments: readonly string[], tail: readonly string[]): boolean {
  if (tail.length > segments.length) return false;
  const offset = segments.length - tail.length;
  return tail.every((segment, index) => segments[offset + index] === segment);
}

function lower(value: string): string {
  return value.toLowerCase();
}
