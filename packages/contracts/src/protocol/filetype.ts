/**
 * Purpose: Canonical filetype registry — maps file extensions and MIME types to
 * a Filetype value that determines the viewer/editor surface.
 *
 * Why centralized: extension→filetype, MIME→filetype, and filetype→schemaType
 * are shared by server (ContextFS, ContextFS, upload services, route
 * handlers) and frontend (context tree, editor config, document toolbar).
 *
 * `Filetype` is the single concept that replaces the former `language`
 * document-level field. Syntax highlighting for code blocks still uses the
 * `code_block` node's `language` attribute, which is derived from the
 * document's filetype for code files.
 */

import type { DocumentFileType } from "./http-types.js";

/** ProseMirror schema backing a Yjs-tracked document. */
export type YjsTrackedSchemaType = "document" | "code";

/**
 * Identifies the viewer/editor surface for a file.
 *
 * - Code filetypes double as the `code_block` language for syntax highlighting.
 * - Binary filetypes (`pdf`, `png`, `jpg`, `svg`) have no ProseMirror schema.
 * - Custom filetypes (`notebook`) require a bespoke viewer (future).
 */
export type Filetype =
  // Rich-text — full document schema
  | "markdown"
  // Code — `code` schema with one code_block child; value doubles as highlight language
  | "python"
  | "typescript"
  | "javascript"
  | "json"
  | "shell"
  | "yaml"
  | "text"
  | "csv"
  // Custom viewers (future — no ProseMirror schema)
  | "notebook"
  // Binary (read-only, S3-backed — no ProseMirror schema)
  | "pdf"
  | "png"
  | "jpg"
  | "svg";

export type FiletypeDisposition =
  | { kind: "tracked"; schemaType: YjsTrackedSchemaType }
  | { kind: "binary"; fileType: DocumentFileType }
  | { kind: "custom"; fileType: DocumentFileType };

export type FiletypeClassification = FiletypeDisposition | { kind: "unknown" };

/**
 * The exhaustive policy for every registered filetype. Adding a registry value
 * cannot silently make it editable: the compiler requires its disposition here.
 */
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
  notebook: { kind: "custom", fileType: "binary" },
  pdf: { kind: "binary", fileType: "pdf" },
  png: { kind: "binary", fileType: "image" },
  jpg: { kind: "binary", fileType: "image" },
  svg: { kind: "binary", fileType: "image" },
} as const satisfies Record<Filetype, FiletypeDisposition>;

const dispositionsByPersistedValue: Readonly<Record<string, FiletypeDisposition | undefined>> =
  FILETYPE_DISPOSITIONS;

/** Classify registered and persisted filetype metadata without throwing. */
export function classifyFiletype(filetype: string | null | undefined): FiletypeClassification {
  if (!filetype) return { kind: "unknown" };
  return dispositionsByPersistedValue[filetype] ?? { kind: "unknown" };
}

/** Fallback filetype when neither extension nor MIME type matches any known type. */
export const DEFAULT_FILETYPE: Filetype = "text";

const extToFiletype: Record<string, Filetype> = {
  md: "markdown",
  markdown: "markdown",
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
  txt: "text",
  toml: "text",
  xml: "text",
  ipynb: "notebook",
  pdf: "pdf",
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  svg: "svg",
};

/**
 * Derive a {@link Filetype} from a file path.
 *
 * Only the extension is considered; the rest of the path is ignored.
 * Extensionless files and unknown extensions return {@link DEFAULT_FILETYPE}.
 */
export function filetypeForPath(path: string): Filetype {
  return filetypeForKnownPath(path) ?? DEFAULT_FILETYPE;
}

/**
 * Derive a {@link Filetype} only when a path extension is in the canonical registry.
 * Extensionless and unknown-extension paths return `null` so callers that must
 * distinguish known text from arbitrary bytes do not treat every blob as text.
 */
export function filetypeForKnownPath(path: string): Filetype | null {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return extToFiletype[extension] ?? null;
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

/**
 * Derive a {@link Filetype} from a MIME type.
 *
 * Only the primary type/subtype are considered; parameters are ignored.
 * Unknown MIME types return {@link DEFAULT_FILETYPE}.
 */
export function filetypeForMimeType(mimeType: string): Filetype {
  return filetypeForKnownMimeType(mimeType) ?? DEFAULT_FILETYPE;
}

/**
 * Derive a {@link Filetype} only when a MIME type is in the canonical registry.
 *
 * This answers which Yjs viewer/editor surface applies — not the persisted
 * {@link DocumentFileType} storage class. Registry entries are limited to MIME
 * types with a distinct editor surface (for example PNG/JPEG/SVG); generic
 * `image/*` types such as WebP are intentionally absent. Use
 * {@link documentFileTypeFor} when classifying uploads for storage.
 *
 * Unknown MIME types return `null` so binary classification does not confuse an
 * arbitrary blob with fallback plain text.
 */
export function filetypeForKnownMimeType(mimeType: string): Filetype | null {
  const semi = mimeType.indexOf(";");
  const clean = semi >= 0 ? mimeType.slice(0, semi).trim() : mimeType.trim();
  return mimeToFiletype[clean] ?? null;
}

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Derive the persisted/document DTO storage class from Yjs filetype plus MIME
 * evidence.
 *
 * Write boundaries call this once and persist `documents.fileType`. Read paths
 * trust that column — they do not re-derive storage class from MIME.
 *
 * When `filetype` is `null` (non-Yjs-tracked uploads), MIME is the only
 * evidence: any `image/*` → `"image"`, `application/pdf` → `"pdf"`, DOCX MIME
 * → `"docx"`, otherwise `"binary"`. DOCX has no `Filetype` because it has no
 * Meridian viewer/editor surface.
 *
 * When `filetype` is set, tracked text/code types return `null`; known binary
 * filetypes collapse to their storage class.
 */
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
