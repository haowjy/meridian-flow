/**
 * The document a canonical link address resolves to, shared by the server's
 * address resolver and the app's local index. The resolve route's wire shape is
 * `document-link-api.ts`; holder-relative addresses are resolved before this
 * (`resolveStoredLinkAddress`). `null` is the normal "nothing there yet" state,
 * not an error, because serial writers link chapters before they write them.
 */

import type { ContextUriScheme } from "../context-uri.js";

export interface ResolvedDocumentLink {
  rootThreadId?: string | null;
  /** The chat whose uploads hold the document. */
  chatThreadId?: string | null;
  documentId: string;
  title: string;
  scheme: ContextUriScheme;
  path: string;
  uri: string;
  workId: string | null;
}
