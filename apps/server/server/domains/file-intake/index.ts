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

// Accept only bare MIME type/subtype; parameters would break the signed PUT header
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export function normalizeMime(mimeType: string): string {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TYPE.test(mime) ? mime : "application/octet-stream";
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

export async function sniffMime(bytes: Uint8Array): Promise<string | null> {
  const detected = await fileTypeFromBuffer(bytes);
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

export const TRACKED_TEXT_MAX_BYTES = 5 * 1024 * 1024;

export function keptFileName(filename: string): { name: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && !/\s/.test(filename.slice(dot + 1))
    ? { name: filename.slice(0, dot), extension: filename.slice(dot + 1) }
    : { name: filename, extension: "" };
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
