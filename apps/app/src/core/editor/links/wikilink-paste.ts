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
  storedHref,
} from "@meridian/contracts";
import {
  type Located,
  locate,
  type ObsidianFinding,
  rankWikilinkMatches,
  scanObsidian,
  storedName,
  type WikilinkTarget,
  wantedPath,
} from "@meridian/markup/obsidian";
import { Fragment, type MarkType, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";

import type { AssignedLink, LinkAssignmentDocument } from "./link-assignment";

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
  return scanObsidian(text, { preprocessed: true }).findings.flatMap<PastedWikilink>((finding) => {
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
  const convert = (fragment: Fragment): Fragment => {
    let changed = false;
    const nodes: PMNode[] = [];
    fragment.forEach((node) => {
      if (node.type.spec.code) {
        nodes.push(node);
        return;
      }
      if (!node.isText) {
        const content = convert(node.content);
        if (content !== node.content) changed = true;
        nodes.push(content === node.content ? node : node.copy(content));
        return;
      }
      const linked = linkText(node, link, resolve);
      if (linked.length !== 1 || linked[0] !== node) changed = true;
      nodes.push(...linked);
    });
    return changed ? Fragment.fromArray(nodes) : fragment;
  };
  const content = convert(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

function linkText(
  node: PMNode,
  link: MarkType,
  resolve: (occurrence: WikilinkOccurrence) => AssignedLink | null,
): PMNode[] {
  const text = node.text ?? "";
  if (node.marks.some((mark) => mark.type.spec.code)) return [node];
  // A link's own text never becomes another link, but its escapes are spelled out.
  const linked = node.marks.some((mark) => mark.type.name === "link");
  const pieces: PMNode[] = [];
  let cursor = 0;
  const { schema } = node.type;
  for (const occurrence of pastedWikilinks(text)) {
    let piece: PMNode | null;
    if ("literal" in occurrence) piece = schema.text(occurrence.literal, node.marks);
    else {
      const assigned = linked ? null : resolve(occurrence);
      piece = assigned
        ? schema.text(
            occurrence.label,
            link.create({ ...assigned, title: null }).addToSet(node.marks),
          )
        : null;
    }
    if (!piece) continue;
    if (occurrence.from > cursor)
      pieces.push(schema.text(text.slice(cursor, occurrence.from), node.marks));
    pieces.push(piece);
    cursor = occurrence.to;
  }
  if (!pieces.length) return [node];
  if (cursor < text.length) pieces.push(schema.text(text.slice(cursor), node.marks));
  return pieces;
}
