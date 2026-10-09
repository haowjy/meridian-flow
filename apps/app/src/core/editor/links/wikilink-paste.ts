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
 * bound to its document's id (`doc:`), spelled with its full address; one that
 * names no document becomes the same dashed link the `@` menu's link-ahead row
 * writes, with a fresh ahead ref for the address that row's rule gives
 * (`linkAhead`).
 */

import {
  aheadAddress,
  documentRef,
  mintAheadRef,
  parseContextUri,
  spellDocumentHref,
} from "@meridian/contracts";
import { filetypeForKnownPath } from "@meridian/contracts/protocol";
import { Fragment, type MarkType, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";

import type { BoundLink, LinkBindingDocument } from "./link-binding";

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
  targets: readonly LinkBindingDocument[];
  /** Where a link to a document nobody has written goes (the link-ahead row's rule). */
  linkAhead: (name: string, folders: readonly string[]) => { uri: string } | null;
};

// An optional `\` or `!` before `[[` is captured so an escape or an embed can
// be told apart; `\[\[` (how Meridian's own Markdown escapes brackets) is an
// escape too. The brackets hold no bracket and no line break.
const WIKILINK = /(\\|!)?\[(\\)?\[([^[\]\n]+)\]\]/g;
// Every escaped opening, closed or not: `\[[` and `\[\[`.
const ESCAPE = /\\\[\\?\[/g;

/** An escaped opening: text, spelled as the literal brackets without the backslash. */
type EscapedWikilink = { from: number; to: number; literal: "[[" };

/**
 * Links and escaped openings, in order; embeds and code are neither. Every
 * escaped opening outside code is found, closed or not, so the backslash the
 * Markdown door kept never reaches the document.
 */
function scanWikilinks(text: string): (WikilinkOccurrence | EscapedWikilink)[] {
  const code = codeSpans(text);
  const inCode = (at: number) => code.some(([from, to]) => at >= from && at < to);
  const found: (WikilinkOccurrence | EscapedWikilink)[] = [];
  for (const match of text.matchAll(ESCAPE)) {
    const start = match.index ?? 0;
    if (!inCode(start)) found.push({ from: start, to: start + match[0].length, literal: "[[" });
  }
  for (const match of text.matchAll(WIKILINK)) {
    const start = match.index ?? 0;
    // An escape (or `[\[`) is no link; an embed stays text.
    if (inCode(start) || match[1] || match[2]) continue;
    const inner = match[3] ?? "";
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
    found.push({
      from: start,
      to: start + match[0].length,
      target: { folders: segments, name },
      suffix,
      label: alias || name.replace(/\.md$/i, ""),
    });
  }
  return found.sort((left, right) => left.from - right.from);
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
 * The link each pasted `[[…]]` becomes: bound to the document it names, or to
 * a fresh ahead ref at the link-ahead address when it names none; null leaves
 * it text. Built once per paste: the candidates are located once and bucketed
 * by filename, so a link only ranks the documents that share its name, and a
 * target seen twice is ranked once.
 */
function wikilinkResolver(
  catalog: WikilinkPasteCatalog,
): (occurrence: WikilinkOccurrence) => BoundLink | null {
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
        href: spellDocumentHref(null, match.uri) + occurrence.suffix,
      };
    const ahead = catalog.linkAhead(target.name, target.folders)?.uri;
    const address = ahead ? aheadAddress(ahead, "link") : null;
    return address
      ? { ref: mintAheadRef(), href: spellDocumentHref(null, address) + occurrence.suffix }
      : null;
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
  resolve: (occurrence: WikilinkOccurrence) => BoundLink | null,
): PMNode[] {
  const text = node.text ?? "";
  if (node.marks.some((mark) => mark.type.spec.code)) return [node];
  // A link's own text never becomes another link, but its escapes are spelled out.
  const linked = node.marks.some((mark) => mark.type.name === "link");
  const pieces: PMNode[] = [];
  let cursor = 0;
  const { schema } = node.type;
  for (const occurrence of scanWikilinks(text)) {
    let piece: PMNode | null;
    if ("literal" in occurrence) piece = schema.text(occurrence.literal, node.marks);
    else {
      const bound = linked ? null : resolve(occurrence);
      piece = bound
        ? schema.text(occurrence.label, link.create({ ...bound, title: null }).addToSet(node.marks))
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

/** Markdown code spans: a backtick run up to the next run of the same length. */
function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const runs = [...text.matchAll(/`+/g)];
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index];
    if (!open) continue;
    const closeIndex = runs.findIndex(
      (run, candidate) => candidate > index && run[0].length === open[0].length,
    );
    const close = runs[closeIndex];
    if (!close) continue;
    spans.push([open.index ?? 0, (close.index ?? 0) + close[0].length]);
    index = closeIndex;
  }
  return spans;
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

/** The lowercased path a target's candidates end with, `.md` implied. */
function wantedPath(target: WikilinkTarget): string[] {
  return [...target.folders, documentName(target.name)].map(lower);
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
