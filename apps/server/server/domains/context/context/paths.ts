export function joinPath(prefix: string, segment: string): string {
  return prefix ? `${prefix}/${segment}` : segment;
}

export function splitPath(path: string): { dir: string[]; filename: string } {
  const segments = path.split("/").filter(Boolean);
  const filename = segments.pop() ?? "";
  return { dir: segments, filename };
}

import { renderFilename } from "@meridian/contracts/protocol";

export { renderFilename } from "@meridian/contracts/protocol";

export function exportFilename(name: string, extension: string, fileType: string): string {
  return renderFilename(name, fileType === "markdown" ? "md" : extension);
}
