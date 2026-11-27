import { z } from "zod";
import { readSegment } from "./entry-segment.js";
import type { DocumentFileType } from "./http-types.js";

export type TrackedSchemaType = "document" | "code";

export type Filetype =
  | "markdown"
  | "python"
  | "typescript"
  | "javascript"
  | "json"
  | "shell"
  | "yaml"
  | "text"
  | "csv"
  | "source"
  | "notebook"
  | "pdf"
  | "png"
  | "jpg"
  | "svg"
  | "docx"
  | "image"
  | "binary";

export type FiletypeDisposition =
  | { kind: "tracked"; schemaType: TrackedSchemaType }
  | { kind: "binary"; fileType: DocumentFileType }
  | { kind: "custom"; fileType: DocumentFileType };

export type FiletypeClassification = FiletypeDisposition | { kind: "unknown" };

const FILETYPE_DISPOSITIONS = {
  markdown: { kind: "tracked", schemaType: "document" },
  python: { kind: "tracked", schemaType: "code" },
  typescript: { kind: "tracked", schemaType: "code" },
  javascript: { kind: "tracked", schemaType: "code" },
  json: { kind: "tracked", schemaType: "code" },
  shell: { kind: "tracked", schemaType: "code" },
  yaml: { kind: "tracked", schemaType: "code" },
  text: { kind: "tracked", schemaType: "document" },
  csv: { kind: "tracked", schemaType: "code" },
  source: { kind: "tracked", schemaType: "code" },
  notebook: { kind: "custom", fileType: "binary" },
  pdf: { kind: "binary", fileType: "pdf" },
  png: { kind: "binary", fileType: "image" },
  jpg: { kind: "binary", fileType: "image" },
  svg: { kind: "binary", fileType: "image" },
  docx: { kind: "binary", fileType: "docx" },
  image: { kind: "binary", fileType: "image" },
  binary: { kind: "binary", fileType: "binary" },
} as const satisfies Record<Filetype, FiletypeDisposition>;

export const filetypeSchema = z.enum(
  Object.keys(FILETYPE_DISPOSITIONS) as [Filetype, ...Filetype[]],
);

const dispositionsByPersistedValue: Readonly<Record<string, FiletypeDisposition | undefined>> =
  FILETYPE_DISPOSITIONS;

// ClassifyFiletype is frozen; a changed kind or schemaType changes replay of stored tree records and needs a migration
export function classifyFiletype(filetype: string | null | undefined): FiletypeClassification {
  if (!filetype) return { kind: "unknown" };
  return Object.hasOwn(dispositionsByPersistedValue, filetype)
    ? (dispositionsByPersistedValue[filetype] ?? { kind: "unknown" })
    : { kind: "unknown" };
}

export const DEFAULT_FILETYPE: Filetype = "markdown";

const extToFiletype: Record<string, Filetype> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  sh: "shell",
  yaml: "yaml",
  yml: "yaml",
  csv: "csv",
  txt: "markdown",
  toml: "text",
  xml: "text",
  ipynb: "notebook",
  pdf: "pdf",
  docx: "docx",
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  svg: "svg",
};

export const PROSE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.entries(extToFiletype)
    .filter(([, type]) => type === "markdown")
    .map(([extension]) => extension),
);

export function registeredExtensionForFiletype(filetype: string): string | null {
  return Object.entries(extToFiletype).find(([, type]) => type === filetype)?.[0] ?? null;
}

export function filetypeForExtension(extension: string): Filetype | null {
  const key = extension.toLowerCase();
  return Object.hasOwn(extToFiletype, key) ? (extToFiletype[key] ?? null) : null;
}

export function filetypeForPath(path: string): Filetype {
  return filetypeForKnownPath(path) ?? DEFAULT_FILETYPE;
}

export function filetypeForKnownPath(path: string): Filetype | null {
  const basename = readSegment(path.slice(path.lastIndexOf("/") + 1).trim()).name;
  const dot = basename.lastIndexOf(".");
  if (dot < 0) return null;
  return filetypeForExtension(basename.slice(dot + 1));
}

const mimeToFiletype: Record<string, Filetype> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/x-python": "python",
  "text/x-typescript": "typescript",
  "application/typescript": "typescript",
  "text/javascript": "javascript",
  "application/javascript": "javascript",
  "application/json": "json",
  "text/x-shellscript": "shell",
  "text/x-yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/yaml": "yaml",
  "text/csv": "csv",
  "text/plain": "text",
  "application/toml": "text",
  "application/xml": "text",
  "text/xml": "text",
  "application/x-ipynb+json": "notebook",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

export function filetypeForStoredFile(mimeType: string): Filetype {
  const known = filetypeForKnownMimeType(mimeType);
  if (known !== null && classifyFiletype(known).kind !== "tracked") return known;
  return documentFileTypeFor({ filetype: null, mimeType }) ?? "binary";
}

export function filetypeForKnownMimeType(mimeType: string): Filetype | null {
  const semi = mimeType.indexOf(";");
  const clean = semi >= 0 ? mimeType.slice(0, semi).trim() : mimeType.trim();
  return Object.hasOwn(mimeToFiletype, clean) ? (mimeToFiletype[clean] ?? null) : null;
}

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function documentFileTypeFor(input: {
  filetype: Filetype | null;
  mimeType: string;
}): DocumentFileType | null {
  const normalizedMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedMime === DOCX_MIME_TYPE) return "docx";
  if (normalizedMime === "application/pdf") return "pdf";
  if (normalizedMime.startsWith("image/")) return "image";

  if (input.filetype === null) return "binary";
  const classification = classifyFiletype(input.filetype);
  return classification.kind === "binary" || classification.kind === "custom"
    ? classification.fileType
    : null;
}
