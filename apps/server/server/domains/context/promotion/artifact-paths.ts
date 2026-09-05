import {
  type CanonicalContextAuthority,
  canonicalContextUri,
} from "@meridian/contracts/context-uri";

export function parentSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replace(/^\/+|\/+$/g, "");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "." : normalized.slice(0, idx);
}

/** Maps a source path to canonical Scratch results under its factual owner. */

export function resultsUriForSourcePath(
  authority: Exclude<CanonicalContextAuthority, { kind: "contextual" }>,
  rootThreadId: string,
  sourcePath: string,
): string {
  const normalized = sourcePath.replace(/^\/+/, "");
  const runPrefix = `runs/${rootThreadId}/`;
  const relative = normalized.startsWith(runPrefix)
    ? normalized.slice(runPrefix.length)
    : normalized;
  return canonicalContextUri("scratch", `results/${relative}`, authority);
}

export function objectStoreKeyForResult(
  projectId: string,
  rootThreadId: string,
  resultId: string,
  sourcePath: string,
): string {
  const baseName = sourcePath.replace(/^\/+/, "").split("/").pop() ?? "artifact";
  return `results/${projectId}/${rootThreadId}/${resultId}/${baseName}`;
}
