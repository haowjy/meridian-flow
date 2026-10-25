/**
 * Port for resolving every internal-link spelling to one project document.
 *
 * Stored href parsing belongs to the shared contracts boundary. This port
 * receives its decoded canonical address and only resolves project ownership
 * and catalog identity.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

export type { ResolvedDocumentLink };

export interface ResolveDocumentLinkInput {
  projectId: string;
  userId: string;
  workId?: string | null;
  rootThreadId?: string | null;
  /** The chat holding the link, when it is a chat's own; a document holder has none. */
  chatId?: string | null;
  uri: string;
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
