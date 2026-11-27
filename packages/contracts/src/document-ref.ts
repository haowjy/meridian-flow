import { parseContextUri } from "./context-uri.js";
import type { FolderId } from "./ids.js";
import {
  canonicalLeaf,
  parseDocumentFilename,
  renderFilename,
} from "./protocol/document-filename.js";
import { parseRequestId } from "./request-id.js";

export type DocumentRef = `doc:${string}`;
export type FolderRef = `folder:${string}`;
export type AheadRef = `ahead:${string}`;
export type LinkRef = DocumentRef | FolderRef | AheadRef;

export type ParsedLinkRef =
  | { kind: "doc"; documentId: string }
  | { kind: "folder"; folderId: FolderId }
  | { kind: "ahead"; aheadId: string };

const REF = /^(doc|folder|ahead):(.*)$/s;

// ParseLinkRef is the untrusted-ref boundary; ids must be canonical UUIDs normalized to lowercase
export function parseLinkRef(value: unknown): ParsedLinkRef | null {
  if (typeof value !== "string") return null;
  const match = REF.exec(value);
  const id = match ? parseRequestId(match[2]) : null;
  if (!match || !id) return null;
  if (match[1] === "doc") return { kind: "doc", documentId: id };
  if (match[1] === "folder") return { kind: "folder", folderId: id };
  return { kind: "ahead", aheadId: id };
}

export function storedLinkRef(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

export function documentRef(documentId: string): DocumentRef {
  const parsed = parseLinkRef(`doc:${documentId}`);
  if (parsed?.kind !== "doc") throw new RangeError(`Invalid document id for a ref: ${documentId}`);
  return `doc:${parsed.documentId}`;
}

export function folderRef(folderId: FolderId): FolderRef {
  const parsed = parseLinkRef(`folder:${folderId}`);
  if (parsed?.kind !== "folder") throw new RangeError(`Invalid folder id for a ref: ${folderId}`);
  return `folder:${parsed.folderId}`;
}

export function mintAheadRef(): AheadRef {
  return `ahead:${crypto.randomUUID()}`;
}

export function isAheadFilename(filename: string): boolean {
  return (
    !filename.includes("/") &&
    /[^.\s]/u.test(filename) &&
    parseDocumentFilename(filename).ok &&
    canonicalLeaf(filename) === filename
  );
}

export function aheadAddress(uri: string, kind: "link" | "source"): string | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok || !parsed.value.path) return null;
  const slash = parsed.value.normalized.lastIndexOf("/");
  const filename = parsed.value.normalized.slice(slash + 1);
  if (kind === "source" && !/^[^/]*[^/.][^/]*\.[^/.]+$/.test(filename)) return null;
  const name = parseDocumentFilename(filename);
  if (!name.ok) return null;
  const canonical = renderFilename(name.value.name, name.value.extension);
  return isAheadFilename(canonical)
    ? parsed.value.normalized.slice(0, slash + 1) + canonical
    : null;
}
