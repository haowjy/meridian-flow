/**
 * Path helpers shared by the scheme adapters. All adapters address a flat,
 * slash-delimited tree of normalized paths (no leading/trailing slash — the
 * router's URI parser guarantees that), so these stay deliberately small.
 */

/** Append a child segment to a parent prefix (root prefix is the empty string). */
export function joinPath(prefix: string, segment: string): string {
  return prefix ? `${prefix}/${segment}` : segment;
}

/** Split a normalized path into its directory segments and trailing filename. */
export function splitPath(path: string): { dir: string[]; filename: string } {
  const segments = path.split("/").filter(Boolean);
  const filename = segments.pop() ?? "";
  return { dir: segments, filename };
}

import { renderFilename } from "@meridian/contracts/protocol";

export { renderFilename } from "@meridian/contracts/protocol";

/** Smallest available writer name; callers own atomic claims and batch reservations. */
export async function allocateFilename(
  parts: { name: string; extension: string },
  exists: (filename: string) => boolean | Promise<boolean>,
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? parts.name : `${parts.name} (${suffix})`;
    const filename = renderFilename(name, parts.extension);
    if (!(await exists(filename))) return filename;
  }
}

/** File output is the only place prose gains a suffix; persisted names stay unchanged. */
export function exportFilename(name: string, extension: string, fileType: string): string {
  return renderFilename(name, fileType === "markdown" ? "md" : extension);
}
