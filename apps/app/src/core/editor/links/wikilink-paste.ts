/**
 * Pasted `[[Name]]` becomes a standard link (D15). Writers bring notes over
 * from Obsidian, whose links would otherwise arrive as dead brackets. Only
 * paste converts: a typed `[[`, what the AI writes, and text already stored
 * stay text.
 *
 * Obsidian's syntax: `[[target]]`, `[[target|label]]`, `[[target#Heading]]`,
 * `[[target#^block]]`, with folders in the target (`Arc 1/Kael`) and `.md`
 * implied when it names no extension. `![[…]]` is an embed and stays text
 * (there is no transclusion); `\[[` is escaped; code is never touched.
 *
 * A target resolves as Obsidian's does, with a fixed order where Obsidian's
 * last step is "the first one it finds" (`pickWikilinkTarget`). One that names
 * no document becomes the same dashed link the `@` menu's link-ahead row
 * writes, at the address that row's rule gives (`linkAhead`).
 */

import { parseContextUri, spellDocumentHref } from "@meridian/contracts";
import { filetypeForKnownPath } from "@meridian/contracts/protocol";
import { Fragment, type MarkType, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";

export type WikilinkTarget = {
  /** Folders before the name, as written (`["Arc 1"]` for `Arc 1/Kael`). */
  folders: readonly string[];
  /** The last segment, as written. */
  name: string;
};

export type WikilinkOccurrence = {
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
  /** The addresses a pasted link may name: the documents the `@` menu offers. */
  targets: readonly string[];
  /** Where a link to a document nobody has written goes (the link-ahead row's rule). */
  linkAhead: (name: string, folders: readonly string[]) => { uri: string } | null;
};

// An optional `\` or `!` before `[[` is captured so an escape or an embed can
// be skipped; the brackets hold no bracket and no line break.
const WIKILINK = /(\\|!)?\[\[([^[\]\n]+)\]\]/g;

/** Every convertible `[[…]]` in a run of text, in order. */
export function parseWikilinks(text: string): WikilinkOccurrence[] {
  const found: WikilinkOccurrence[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    if (match[1]) continue;
    const inner = match[2] ?? "";
    // Inside a table Obsidian escapes the alias bar as `\|`.
    const bar = inner.search(/\\?\|/);
    const destination = bar < 0 ? inner : inner.slice(0, bar);
    const alias =
      bar < 0
        ? ""
        : inner
            .slice(bar)
            .replace(/^\\?\|/, "")
            .trim();
    const hash = destination.indexOf("#");
    const path = (hash < 0 ? destination : destination.slice(0, hash)).trim();
    const suffix = hash < 0 ? "" : destination.slice(hash).trim();
    const segments = path.split("/").map((segment) => segment.trim());
    const name = segments.pop() ?? "";
    if (!name || segments.some((segment) => !segment)) continue;
    const from = match.index ?? 0;
    found.push({
      from,
      to: from + match[0].length,
      target: { folders: segments, name },
      suffix,
      label: alias || name.replace(/\.md$/i, ""),
    });
  }
  return found;
}

type Located = { uri: string; area: string; scheme: string; segments: string[] };

/** Fixed order for an exact path in another area; the holder's own area is first. */
const AREA_ORDER = ["manuscript", "kb", "user", "scratch"];

/**
 * Which candidate a target names, of those whose path ends with it. The
 * project has several areas where Obsidian has one vault, and Obsidian's last
 * step is index order, so ours is fixed:
 *
 * - `[[Name]]`: the holder's own folder, then the holder's area root, then
 *   the rest (holder's area first, fewest folders, alphabetical URI).
 * - `[[a/Name]]`: that path from the holder's area root, then from another
 *   area's root (Manuscript, KB, User, Scratch), then the rest as above.
 *
 * Comparisons ignore case. Null only when nothing matches.
 */
export function pickWikilinkTarget(
  candidates: readonly string[],
  target: WikilinkTarget,
  holderUri: string | null,
): string | null {
  const wanted = [...target.folders, documentName(target.name)].map(lower);
  const matches = candidates.flatMap((uri) => {
    const located = locate(uri);
    return located && endsWith(located.segments, wanted) ? [located] : [];
  });
  if (!matches.length) return null;
  const holder = holderUri ? locate(holderUri) : null;
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
    if (hit) return hit.uri;
  }
  const [first] = [...matches].sort(
    (left, right) =>
      Number(inHolderArea(right)) - Number(inHolderArea(left)) ||
      left.segments.length - right.segments.length ||
      (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0),
  );
  return first?.uri ?? null;
}

/**
 * The href a pasted `[[…]]` becomes, spelled from the holder: the document it
 * names, or the link-ahead address when it names none. Null leaves it text.
 */
export function wikilinkHref(
  occurrence: WikilinkOccurrence,
  catalog: WikilinkPasteCatalog,
): string | null {
  const uri =
    pickWikilinkTarget(catalog.targets, occurrence.target, catalog.holderUri) ??
    catalog.linkAhead(occurrence.target.name, occurrence.target.folders)?.uri;
  return uri ? spellDocumentHref(catalog.holderUri, uri) + occurrence.suffix : null;
}

/**
 * The pasted slice with each convertible `[[…]]` as a link. Code (a fence or
 * a code mark) and text already inside a link are left as they are.
 */
export function linkPastedWikilinks(
  slice: Slice,
  schema: Schema,
  catalog: WikilinkPasteCatalog,
): Slice {
  const link = schema.marks.link;
  if (!link) return slice;
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
      const linked = linkText(node, link, catalog);
      if (linked.length !== 1 || linked[0] !== node) changed = true;
      nodes.push(...linked);
    });
    return changed ? Fragment.fromArray(nodes) : fragment;
  };
  const content = convert(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

function linkText(node: PMNode, link: MarkType, catalog: WikilinkPasteCatalog): PMNode[] {
  const text = node.text ?? "";
  if (node.marks.some((mark) => mark.type.spec.code || mark.type.name === "link")) return [node];
  const pieces: PMNode[] = [];
  let cursor = 0;
  for (const occurrence of parseWikilinks(text)) {
    const href = wikilinkHref(occurrence, catalog);
    if (!href) continue;
    if (occurrence.from > cursor)
      pieces.push(node.type.schema.text(text.slice(cursor, occurrence.from), node.marks));
    pieces.push(
      node.type.schema.text(
        occurrence.label,
        link.create({ href, title: null }).addToSet(node.marks),
      ),
    );
    cursor = occurrence.to;
  }
  if (!pieces.length) return [node];
  if (cursor < text.length) pieces.push(node.type.schema.text(text.slice(cursor), node.marks));
  return pieces;
}

function locate(uri: string): Located | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok || !parsed.value.path) return null;
  return {
    uri,
    area: `${parsed.value.scheme} ${JSON.stringify(parsed.value.authority)}`,
    scheme: parsed.value.scheme,
    segments: parsed.value.path.split("/").map(lower),
  };
}

/** A name as a filename: `.md` implied when it names no known extension. */
function documentName(name: string): string {
  return filetypeForKnownPath(name) ? name : `${name}.md`;
}

function endsWith(segments: readonly string[], tail: readonly string[]): boolean {
  if (tail.length > segments.length) return false;
  const offset = segments.length - tail.length;
  return tail.every((segment, index) => segments[offset + index] === segment);
}

function lower(value: string): string {
  return value.toLowerCase();
}
