/**
 * The stable target a stored internal link (or `image`/`figure` source) carries.
 *
 * A ref lives only on the stored ProseMirror attrs: it never appears in
 * Markdown, HTML, MDX, export, URIs or anything the model reads. A document
 * ref names the document itself; an ahead ref is minted for an address where
 * no document is yet and settles on the first one to arrive there.
 */
import { parseContextUri } from "./context-uri.js";
import type { FolderId } from "./ids.js";
import { parseDocumentFilename, renderFilename } from "./protocol/document-filename.js";
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

/**
 * Null for null, the empty string, and anything malformed (never throws).
 * Document and ahead ids are Postgres UUIDs, so the id must be a canonical
 * UUID (normalized to lowercase); this is the one boundary that keeps
 * untrusted clipboard or wire refs from reaching a lookup.
 */
export function parseLinkRef(value: unknown): ParsedLinkRef | null {
  if (typeof value !== "string") return null;
  const match = REF.exec(value);
  const id = match ? parseRequestId(match[2]) : null;
  if (!match || !id) return null;
  if (match[1] === "doc") return { kind: "doc", documentId: id };
  if (match[1] === "folder") return { kind: "folder", folderId: id };
  return { kind: "ahead", aheadId: id };
}

/**
 * A stored `ref` attr as every reader takes it (codec, occurrence walks, Yjs
 * extraction, the editor): null only when absent or empty, else the attr as
 * stored. A present malformed ref stays a ref, so `resolveStoredLink` answers
 * it gone instead of whatever sits at its address; `parseLinkRef` still
 * guards every lookup.
 */
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

/** `ahead:` + crypto.randomUUID(). The only minting function, server and client. */
export function mintAheadRef(): AheadRef {
  return `ahead:${crypto.randomUUID()}`;
}

/** A canonical codec name with a non-dot stem, admissible in the ahead registry. */
export function isAheadFilename(filename: string): boolean {
  const parsed = parseDocumentFilename(filename);
  return (
    !filename.includes("/") &&
    /[^.\s]/u.test(filename) &&
    parsed.ok &&
    renderFilename(parsed.value.name, parsed.value.extension) === filename
  );
}

/**
 * Mint at the codec's canonical name. Dots-only names stay literal. Sources
 * still need a written extension: extensionless uploads cannot settle them.
 */
export function aheadAddress(uri: string, kind: "link" | "source"): string | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok || !parsed.value.path || !/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return null;
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
