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
  workId?: string | null;
  target: DocumentLinkTarget;
}

export interface DocumentLinkResolver {
  resolve(input: ResolveDocumentLinkInput): Promise<ResolvedDocumentLink | null>;
}
