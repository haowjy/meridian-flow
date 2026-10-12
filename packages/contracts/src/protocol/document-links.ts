/**
 * Address-level document-link resolution shapes, shared by the server's address resolver
 * and the app's local index. The resolve route's wire shape is `document-link-api.ts`.
 *
 * A link is a standard Markdown link to an address: a Context URI, or a path
 * relative to the document holding the link. `null` is the normal "nothing there
 * yet" state, not an error, because serial writers link chapters before they write them.
 *
 * External links never appear here. They are the client's own business and
 * need no server round trip.
 */

import type { ContextUriScheme } from "../context-uri.js";

export type DocumentLinkTarget =
  | { kind: "scheme"; uri: string }
  | { kind: "relative"; path: string; baseUri: string };

export interface ResolvedDocumentLink {
  rootThreadId?: string | null;
  documentId: string;
  title: string;
  scheme: ContextUriScheme;
  path: string;
  uri: string;
  workId: string | null;
}
