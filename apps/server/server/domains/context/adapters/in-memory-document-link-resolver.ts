/** Mutable in-memory adapter for the document-link resolution port. */

import { type DocumentLinkCandidate, resolveDocumentLink } from "../document-link-resolution.js";
import type {
  DocumentLinkResolver,
  ResolveDocumentLinkInput,
} from "../ports/document-link-resolver.js";

export class InMemoryDocumentLinkResolver implements DocumentLinkResolver {
  private readonly candidates: DocumentLinkCandidate[];

  constructor(candidates: readonly DocumentLinkCandidate[] = []) {
    this.candidates = [...candidates];
  }

  remember(candidate: DocumentLinkCandidate): void {
    const existing = this.candidates.findIndex(
      (entry) => entry.documentId === candidate.documentId,
    );
    if (existing === -1) this.candidates.push(candidate);
    else this.candidates[existing] = candidate;
  }

  resolve(input: ResolveDocumentLinkInput) {
    return Promise.resolve(resolveDocumentLink(this.candidates, input));
  }
}
