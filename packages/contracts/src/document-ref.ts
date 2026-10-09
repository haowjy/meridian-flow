/**
 * The stable target a stored internal link (or `image`/`figure` source) carries.
 *
 * A ref lives only on the stored ProseMirror attrs: it never appears in
 * Markdown, HTML, MDX, export, URIs or anything the model reads. A document
 * ref names the document itself; an ahead ref is minted for an address where
 * no document is yet and settles on the first one to arrive there.
 */
import { parseContextUri } from "./context-uri.js";

export type DocumentRef = `doc:${string}`;
export type AheadRef = `ahead:${string}`;
export type LinkRef = DocumentRef | AheadRef;

export type ParsedLinkRef =
  | { kind: "doc"; documentId: string }
  | { kind: "ahead"; aheadId: string };

// Ids are UUIDs in production; tests use short readable ids, so the grammar
// only fences out separators and whitespace rather than demanding a UUID.
const REF = /^(doc|ahead):([A-Za-z0-9_-]+)$/;

/** Null for null, the empty string, and anything malformed (never throws). */
export function parseLinkRef(value: unknown): ParsedLinkRef | null {
  if (typeof value !== "string") return null;
  const match = REF.exec(value);
  if (!match) return null;
  const [, kind, id = ""] = match;
  return kind === "doc" ? { kind: "doc", documentId: id } : { kind: "ahead", aheadId: id };
}

export function documentRef(documentId: string): DocumentRef {
  const ref = `doc:${documentId}` as const;
  if (!parseLinkRef(ref)) throw new RangeError(`Invalid document id for a ref: ${documentId}`);
  return ref;
}

/** `ahead:` + crypto.randomUUID(). The only minting function, server and client. */
export function mintAheadRef(): AheadRef {
  return `ahead:${crypto.randomUUID()}`;
}

/**
 * The address an ahead ref is minted for: canonical, absolute, suffix-free,
 * always with an extension. A link without one gets `.md` (the default the app
 * creates). Image and figure sources without an extension return null: an
 * upload always has one, so such a ref could never settle, and the caller
 * treats the source as a literal (no ref).
 */
export function aheadAddress(uri: string, kind: "link" | "source"): string | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok || !parsed.value.path || !/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return null;
  const filename = parsed.value.path.slice(parsed.value.path.lastIndexOf("/") + 1);
  if (filename.lastIndexOf(".") > 0) return parsed.value.normalized;
  return kind === "link" ? `${parsed.value.normalized}.md` : null;
}
