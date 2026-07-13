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

const NON_TRACKED_FILETYPES = ["notebook", "pdf", "png", "jpg", "svg"] as const;

/** Registered filetypes that cannot be represented by a Yjs text document. */
export type NonTrackedFiletype = (typeof NON_TRACKED_FILETYPES)[number];

/** Filetypes that can be represented by a Yjs text document. */
export type TrackedFiletype = Exclude<Filetype, NonTrackedFiletype>;

declare const persistedTrackedFiletypeBrand: unique symbol;

/** An unregistered persisted value validated as not being a known non-text filetype. */
export type PersistedTrackedFiletype = string & {
  readonly [persistedTrackedFiletypeBrand]: true;
};

const nonTrackedFiletypes: ReadonlySet<string> = new Set(NON_TRACKED_FILETYPES);

/** Classify a registry filetype before entering a tracked-text boundary. */
export function isTrackedFiletype(filetype: Filetype): filetype is TrackedFiletype {
  return !nonTrackedFiletypes.has(filetype);
}

/** Validate persisted filetype metadata before resolving its tracked schema. */
export function trackedFiletypeForPersistedValue(
  filetype: string | null | undefined,
): TrackedFiletype | PersistedTrackedFiletype | null | undefined {
  if (filetype && nonTrackedFiletypes.has(filetype)) {
    throw new TypeError(`Filetype "${filetype}" cannot be represented by a tracked text document`);
  }
  return filetype as TrackedFiletype | PersistedTrackedFiletype | null | undefined;
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

  switch (input.filetype) {
    case null:
      return "binary";
    case "png":
    case "jpg":
    case "svg":
      return "image";
    case "pdf":
      return "pdf";
    default:
      return null;
  }
}

/**
 * Derive a ProseMirror schema type from a filetype.
 *
 * Only text-editable filetypes have a schema type. Binary and custom filetypes
 * return `null` — they are not backed by Yjs documents.
 */
export function schemaTypeForFiletype(ft: Filetype | (string & {})): YjsTrackedSchemaType | null {
  switch (ft) {
    case "markdown":
    case "text":
      return "document";
    case "python":
    case "typescript":
    case "javascript":
    case "json":
    case "shell":
    case "yaml":
    case "csv":
      return "code";
    default:
      return null;
  }
}

/**
 * Resolve the schema for a document already known to be Yjs-tracked/editable.
 *
 * Persisted rows can predate the current filetype registry, so this boundary is
 * deliberately total: only the explicit code allowlist selects the strict code
 * schema; missing, unknown, and prose filetypes select the document schema.
 * Binary/custom classification must happen before calling this resolver.
 */
export function schemaTypeForTrackedFiletype(
  ft: TrackedFiletype | PersistedTrackedFiletype | null | undefined,
): YjsTrackedSchemaType {
  switch (trackedFiletypeForPersistedValue(ft)) {
    case "python":
    case "typescript":
    case "javascript":
    case "json":
    case "shell":
    case "yaml":
    case "csv":
      return "code";
    default:
      return "document";
  }
}
