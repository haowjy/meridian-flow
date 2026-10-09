/**
 * Port for resolving every internal-link spelling to one project document.
 *
 * The target and resolved shapes are the wire contract the editor also speaks
 * (`@meridian/contracts/protocol`), so a new spelling is added once rather
 * than on both sides of the endpoint.
 */

import type { DocumentLinkTarget, ResolvedDocumentLink } from "@meridian/contracts/protocol";

export type { DocumentLinkTarget, ResolvedDocumentLink };

export interface ResolveDocumentLinkInput {
  projectId: string;
  userId: string;
  workId?: string | null;
  rootThreadId?: string | null;
  target: DocumentLinkTarget;
  /** Chat only: a link with no holder may follow a vacated path to the document that left it. */
  previousLocations?: boolean;
}

export interface DocumentLinkResolver {
  resolve(input: ResolveDocumentLinkInput): Promise<ResolvedDocumentLink | null>;
}

/** Chat-only previous-location fallback, filtered to documents the reader may name. */
export interface DocumentLinkHistory {
  previous(
    input: ResolveDocumentLinkInput,
    address: {
      scope: import("@meridian/contracts/protocol").CatalogScope;
      scheme: import("@meridian/contracts").ContextUriScheme;
      path: string;
    },
  ): Promise<string | null>;
}
