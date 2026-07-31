/**
 * Wire contract for internal document-link resolution.
 *
 * Three spellings, one family (interaction model §5.5): a wikilink title, a
 * `manuscript://` or `work://` URI, and a path relative to the document that
 * holds the link. The editor classifies an href into one of these and the
 * server resolves it to a project document; `null` back is the normal
 * unresolved state, not an error, because serial writers link chapters before
 * they write them.
 *
 * External links never appear here. They are the client's own business and
 * need no server round trip.
 */

export type DocumentLinkTarget =
  | { kind: "wikilink"; name: string }
  | { kind: "scheme"; uri: string }
  | { kind: "relative"; path: string; baseUri: string };

export interface ResolvedDocumentLink {
  documentId: string;
  title: string;
  scheme: "manuscript" | "work";
  path: string;
  uri: string;
  workId: string | null;
}

/** POST `/api/projects/:projectId/links/resolve`. */
export interface ResolveDocumentLinkRequest {
  workId?: string | null;
  target: DocumentLinkTarget;
}

/** `document` is null when nothing matched, or when several did. */
export interface ResolveDocumentLinkResponse {
  document: ResolvedDocumentLink | null;
}
