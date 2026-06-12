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

/** Split a filename into a base name and extension (no leading dot). */
export function parseFilename(filename: string): { name: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { name: filename, extension: "" };
  return { name: filename.slice(0, dot), extension: filename.slice(dot + 1) };
}

/** Render a base name + extension back into a filename. */
export function renderFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}
