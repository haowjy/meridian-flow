/**
 * Shared upload/import byte classification and document filename codec.
 *
 * Classification is layered: `file-type` binary signatures first, then the declared MIME and
 * extension table for text-like formats. A signature that names a binary format (RTF, archives,
 * office, media) wins over the extension and never classifies as text.
 */
import type { Filetype } from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  documentFileTypeFor,
  filenameForBinary,
  filetypeForKnownMimeType,
  filetypeForKnownPath,
  parseDocumentFilename,
  registeredExtensionForFiletype,
} from "@meridian/contracts/protocol";
import { fileTypeFromBuffer } from "file-type";

const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/markdown",
  "application/toml",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
]);

export function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

export function normalizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop()?.normalize("NFKC").trim() || "upload";
  const safe = [...basename]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .replace(/^@+/, "")
    .trim();
  return !safe || safe === "." || safe === ".." ? "upload" : safe;
}

function isTextLikeMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    TEXT_MIMES.has(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

/**
 * Binary format named by the leading bytes, or null. Import classifies from the manifest's
 * 512-byte sniff, which bounds detection to signatures inside that window: a ZIP-based office file
 * reads as a plain archive there, and the DOCX extension is handled before this runs.
 */
export async function sniffMime(bytes: Uint8Array): Promise<string | null> {
  const detected = await fileTypeFromBuffer(bytes);
  // file-type also names XML, which is text.
  return detected && !isTextLikeMime(detected.mime) ? detected.mime : null;
}

export async function classifyUpload(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<Filetype> {
  const sniffed = await sniffMime(input.bytes);
  const mime = sniffed ?? normalizeMime(input.mimeType);
  const byMime = filetypeForKnownMimeType(mime);
  const byPath = filetypeForKnownPath(input.filename);
  const textLike =
    isTextLikeMime(mime) || (!input.bytes.includes(0) && mime === "application/octet-stream");
  if (textLike) {
    const candidate = byPath ?? byMime ?? "text";
    const classification = classifyFiletype(candidate);
    if (classification.kind === "tracked")
      return candidate === "text" && byPath === null ? "markdown" : candidate;
    return classification.kind === "unknown" ? "text" : classification.fileType;
  }
  const candidate = byMime ?? byPath;
  if (candidate) {
    const classification = classifyFiletype(candidate);
    if (classification.kind === "binary" || classification.kind === "custom") {
      return classification.fileType;
    }
  }
  return documentFileTypeFor({ filetype: null, mimeType: mime }) ?? "binary";
}

export function intakeFilename(filename: string, fileType: Filetype, mimeType: string) {
  const tracked = classifyFiletype(fileType).kind === "tracked";
  const parsed = parseDocumentFilename(filename, {
    sourceExtension: tracked ? (registeredExtensionForFiletype(fileType) ?? undefined) : undefined,
  });
  return parsed.ok && !tracked
    ? { ok: true as const, value: filenameForBinary(parsed.value, fileType, mimeType) }
    : parsed;
}
