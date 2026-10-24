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
  /** The chat holding the link, when it is a chat's own; a document holder has none. */
  chatId?: string | null;
  target: DocumentLinkTarget;
  /** Whether a vacated path follows its living document or only reports that it is gone. */
  previousLocations?: "follow" | "gone";
}

export interface DocumentLinkResolver {
  resolve(input: ResolveDocumentLinkInput): Promise<ResolvedDocumentLink | { kind: "gone" } | null>;
}

export type PreviousDocumentLink = { kind: "living"; uri: string } | { kind: "gone" };

/** Scoped previous-location lookup, filtered to documents the reader may name. */
export interface DocumentLinkHistory {
  previous(
    input: ResolveDocumentLinkInput,
    address: {
      scope: import("@meridian/contracts/protocol").CatalogScope;
      scheme: import("@meridian/contracts").ContextUriScheme;
      path: string;
    },
  ): Promise<PreviousDocumentLink | null>;
}
