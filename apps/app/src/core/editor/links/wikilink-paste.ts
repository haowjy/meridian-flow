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
  /** The addresses a pasted link may name: the Editor's link index, in the areas a link names. */
  targets: readonly string[];
  /** Where a link to a document nobody has written goes (the link-ahead row's rule). */
  linkAhead: (name: string, folders: readonly string[]) => { uri: string } | null;
};

// An optional `\` or `!` before `[[` is captured so an escape or an embed can
// be told apart; `\[\[` (how Meridian's own Markdown escapes brackets) is an
// escape too. The brackets hold no bracket and no line break.
const WIKILINK = /(\\|!)?\[(\\)?\[([^[\]\n]+)\]\]/g;

/** An escaped `\[[…]]`: text, spelled as the literal brackets without the backslash. */
type EscapedWikilink = { from: number; to: number; literal: string };

/**
 * Every convertible `[[…]]` in a run of text, in order. A backtick code span
 * still spelled out in the text (paste without formatting keeps it literal)
 * is code, and code is never converted.
 */
export function parseWikilinks(text: string): WikilinkOccurrence[] {
  return scanWikilinks(text).filter((found): found is WikilinkOccurrence => "target" in found);
}

/** Links and escapes, in order; embeds and code are neither. */
function scanWikilinks(text: string): (WikilinkOccurrence | EscapedWikilink)[] {
  const found: (WikilinkOccurrence | EscapedWikilink)[] = [];
  const code = codeSpans(text);
  for (const match of text.matchAll(WIKILINK)) {
    const start = match.index ?? 0;
    if (code.some(([from, to]) => start >= from && start < to)) continue;
    const inner = match[3] ?? "";
    if (match[1] === "\\") {
      found.push({ from: start, to: start + match[0].length, literal: `[[${inner}]]` });
      continue;
    }
    if (match[1] || match[2]) continue;
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
  const located = candidates.flatMap((uri) => locate(uri) ?? []);
  return rankWikilinkMatches(located, target, holderUri ? locate(holderUri) : null);
}

function rankWikilinkMatches(
  candidates: readonly Located[],
  target: WikilinkTarget,
  holder: Located | null,
): string | null {
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
 * The href each pasted `[[…]]` becomes, spelled from the holder: the document
 * it names, or the link-ahead address when it names none; null leaves it
 * text. Built once per paste: the candidates are located once and bucketed by
 * filename, so a link only ranks the documents that share its name, and a
 * target seen twice is answered once.
 */
export function wikilinkResolver(
  catalog: WikilinkPasteCatalog,
): (occurrence: WikilinkOccurrence) => string | null {
  const byName = new Map<string, Located[]>();
  for (const uri of catalog.targets) {
    const located = locate(uri);
    const name = located?.segments.at(-1);
    if (!located || name === undefined) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push(located);
    else byName.set(name, [located]);
  }
  const holder = catalog.holderUri ? locate(catalog.holderUri) : null;
  const answers = new Map<string, string | null>();
  return (occurrence) => {
    const { target } = occurrence;
    const wanted = wantedPath(target);
    const key = wanted.join("/");
    let uri = answers.get(key);
    if (uri === undefined) {
      uri =
        rankWikilinkMatches(byName.get(wanted.at(-1) ?? "") ?? [], target, holder) ??
        catalog.linkAhead(target.name, target.folders)?.uri ??
        null;
      answers.set(key, uri);
    }
    return uri ? spellDocumentHref(catalog.holderUri, uri) + occurrence.suffix : null;
  };
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
  const resolve = wikilinkResolver(catalog);
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
  resolve: (occurrence: WikilinkOccurrence) => string | null,
): PMNode[] {
  const text = node.text ?? "";
  if (node.marks.some((mark) => mark.type.spec.code || mark.type.name === "link")) return [node];
  const pieces: PMNode[] = [];
  let cursor = 0;
  const { schema } = node.type;
  for (const occurrence of scanWikilinks(text)) {
    let piece: PMNode | null;
    if ("literal" in occurrence) piece = schema.text(occurrence.literal, node.marks);
    else {
      const href = resolve(occurrence);
      piece = href
        ? schema.text(occurrence.label, link.create({ href, title: null }).addToSet(node.marks))
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
