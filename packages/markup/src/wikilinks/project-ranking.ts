import { parseContextUri } from "@meridian/contracts";
import { canonicalLeaf } from "@meridian/contracts/protocol";
export type WikilinkTarget = { folders: readonly string[]; name: string };

export type Located = {
  uri: string;
  documentId: string | null;
  area: string;
  scheme: string;
  segments: string[];
};

const AREA_ORDER = ["manuscript", "kb", "unfiled", "user", "scratch"];

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

export function wantedPath(target: WikilinkTarget): string[] {
  return [...target.folders, storedName(target.name)].map(lower);
}

export function storedName(name: string): string {
  return canonicalLeaf(name);
}

function endsWith(segments: readonly string[], tail: readonly string[]): boolean {
  if (tail.length > segments.length) return false;
  const offset = segments.length - tail.length;
  return tail.every((segment, index) => segments[offset + index] === segment);
}

function lower(value: string): string {
  return value.toLowerCase();
}
