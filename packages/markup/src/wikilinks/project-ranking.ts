/** Project-wide wikilink ranking shared by paste and import over plain located candidates. */
import { parseContextUri } from "@meridian/contracts";
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
export type WikilinkTarget = { folders: readonly string[]; name: string };

export type Located = {
  uri: string;
  documentId: string | null;
  area: string;
  scheme: string;
  segments: string[];
};

/** Fixed order for an exact path in another area; the holder's own area is first. */
const AREA_ORDER = ["manuscript", "kb", "unfiled", "user", "scratch"];

/**
 * Which candidate a target names, of those whose path ends with it. The
 * project has several areas where a note app has one folder, and its last
 * step is index order, so ours is fixed. `holder` is the document the paste
 * lands in, or null when it has no address yet.
 *
 * - `[[Name]]`: the holder's own folder, then the holder's area root, then
 *   the rest (holder's area first, fewest folders, alphabetical URI).
 * - `[[a/Name]]`: that path from the holder's area root, then from another
 *   area's root (Manuscript, KB, Unfiled, User, Scratch), then the rest as above.
 *
 * Comparisons ignore case. Null only when nothing matches.
 */
export function rankWikilinkMatches(
  candidates: readonly Located[],
  target: WikilinkTarget,
  holder: Located | null,
): Located | null {
  const wanted = wantedPath(target);
  const matches = wikilinkMatches(candidates, target);
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

/** Every candidate whose path ends with the target, segment by segment: the ranked set. */
export function wikilinkMatches(candidates: readonly Located[], target: WikilinkTarget): Located[] {
  const wanted = wantedPath(target);
  return candidates.filter((candidate) => endsWith(candidate.segments, wanted));
}

export function locate(uri: string, documentId: string | null): Located | null {
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
export function wantedPath(target: WikilinkTarget): string[] {
  return [...target.folders, storedName(target.name)].map(lower);
}

/** What a written name is stored as: `Chapter 13.md` is `Chapter 13`, `outline.json` stays. */
export function storedName(name: string): string {
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
