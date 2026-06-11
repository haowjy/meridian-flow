import type { DocumentFileType } from "./http-types.js";
import type { YjsTrackedSchemaType } from "./yjs-multiplex.js";

export type Filetype = "markdown" | "text";

export const DEFAULT_FILETYPE: Filetype = "text";

export function filetypeForPath(path: string): Filetype {
  return filetypeForKnownPath(path) ?? DEFAULT_FILETYPE;
}

export function filetypeForKnownPath(path: string): Filetype | null {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt" || extension === "text") return "text";
  return null;
}

export function filetypeForMimeType(mimeType: string): Filetype {
  return filetypeForKnownMimeType(mimeType) ?? DEFAULT_FILETYPE;
}

export function filetypeForKnownMimeType(mimeType: string): Filetype | null {
  const semi = mimeType.indexOf(";");
  const clean = semi >= 0 ? mimeType.slice(0, semi).trim() : mimeType.trim();
  if (clean === "text/markdown" || clean === "text/x-markdown") return "markdown";
  if (clean === "text/plain") return "text";
  return null;
}

export function documentFileTypeFor(_input: {
  filetype: Filetype | null;
  mimeType: string;
}): DocumentFileType | null {
  return null;
}

export function schemaTypeForFiletype(ft: Filetype): YjsTrackedSchemaType | null {
  return ft === "markdown" ? "document" : null;
}
