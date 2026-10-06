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
  target: DocumentLinkTarget;
  holder?: { documentId: string; href: string };
}

export interface DocumentLinkResolver {
  resolve(input: ResolveDocumentLinkInput): Promise<ResolvedDocumentLink | null>;
}

/** A present redirect suppresses address fallback even when its target is unavailable. */
export interface DocumentLinkHistory {
  redirect(input: ResolveDocumentLinkInput): Promise<{ uri: string | null } | null>;
  previous(
    input: ResolveDocumentLinkInput,
    address: {
      scope: import("@meridian/contracts/protocol").CatalogScope;
      scheme: import("@meridian/contracts").ContextUriScheme;
      path: string;
    },
  ): Promise<string | null>;
}
