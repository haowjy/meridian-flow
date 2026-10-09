/**
 * The stable target a stored internal link (or `image`/`figure` source) carries.
 *
 * A ref lives only on the stored ProseMirror attrs: it never appears in
 * Markdown, HTML, MDX, export, URIs or anything the model reads. A document
 * ref names the document itself; an ahead ref is minted for an address where
 * no document is yet and settles on the first one to arrive there.
 */
import { parseContextUri } from "./context-uri.js";
import { parseRequestId } from "./request-id.js";

export type DocumentRef = `doc:${string}`;
export type AheadRef = `ahead:${string}`;
export type LinkRef = DocumentRef | AheadRef;

export type ParsedLinkRef =
  | { kind: "doc"; documentId: string }
  | { kind: "ahead"; aheadId: string };

const REF = /^(doc|ahead):(.*)$/s;

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
  return match[1] === "doc" ? { kind: "doc", documentId: id } : { kind: "ahead", aheadId: id };
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

/** `ahead:` + crypto.randomUUID(). The only minting function, server and client. */
export function mintAheadRef(): AheadRef {
  return `ahead:${crypto.randomUUID()}`;
}

/**
 * Whether a filename has a real extension: a nonempty one after a stem with
 * something besides dots (`.hidden` and `chapter.` have none). The one rule
 * for what an ahead ref may be registered at, minted and registry alike.
 */
export function hasFileExtension(filename: string): boolean {
  return /^[^/]*[^/.][^/]*\.[^/.]+$/.test(filename);
}

/**
 * The address an ahead ref is minted for: canonical, absolute, suffix-free,
 * decoded (a catalog/registry key, not a stored href; store it with
 * `storedHref`), always with a real extension (`hasFileExtension`). A link
 * without one gets `.md` appended (the default the app creates, so `chapter.`
 * becomes `chapter..md`). Image and figure sources without one return null: an
 * upload always has one, so such a ref could never settle, and the caller
 * treats the source as a literal (no ref).
 */
export function aheadAddress(uri: string, kind: "link" | "source"): string | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok || !parsed.value.path || !/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return null;
  const filename = parsed.value.path.slice(parsed.value.path.lastIndexOf("/") + 1);
  if (hasFileExtension(filename)) return parsed.value.normalized;
  return kind === "link" ? `${parsed.value.normalized}.md` : null;
}
