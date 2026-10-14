/** Shared upload/import byte classification and document filename codec. */
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

export function classifyUpload(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Filetype {
  const sniffed = sniffMime(input.bytes);
  const mime = sniffed ?? normalizeMime(input.mimeType);
  const byMime = filetypeForKnownMimeType(mime);
  const byPath = filetypeForKnownPath(input.filename);
  const textLike =
    mime.startsWith("text/") ||
    TEXT_MIMES.has(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    (!input.bytes.includes(0) && mime === "application/octet-stream");
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

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return "application/pdf";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return "image/gif";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)
    return "application/zip";
  return null;
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
