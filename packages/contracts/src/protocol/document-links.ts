/**
 * Wire contract for internal document-link resolution.
 *
 * A link is a standard Markdown link to an address: a Context URI, or a path
 * relative to the document holding the link. The editor classifies an href
 * into one of these and the server resolves it to the one document at that
 * address; `null` back is the normal "nothing there yet" state, not an error,
 * because serial writers link chapters before they write them.
 *
 * External links never appear here. They are the client's own business and
 * need no server round trip.
 */

import type { ContextUriScheme } from "../context-uri.js";

export type DocumentLinkTarget =
  | { kind: "scheme"; uri: string }
  | { kind: "relative"; path: string; baseUri: string };

export interface ResolvedDocumentLink {
  documentId: string;
  title: string;
  scheme: ContextUriScheme;
  path: string;
  uri: string;
  workId: string | null;
}

/** POST `/api/projects/:projectId/links/resolve`. */
export interface ResolveDocumentLinkRequest {
  workId?: string | null;
  target: DocumentLinkTarget;
}

/** `document` is null when nothing is at that address. */
export interface ResolveDocumentLinkResponse {
  document: ResolvedDocumentLink | null;
}
