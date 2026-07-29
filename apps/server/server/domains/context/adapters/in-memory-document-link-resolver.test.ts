/** In-memory document-link resolver conformance. */

import type { DocumentLinkCandidate } from "../document-link-resolution.js";
import {
  type DocumentLinkResolverContractHarness,
  registerDocumentLinkResolverContract,
} from "./__conformance__/document-link-resolver.contract.js";
import { InMemoryDocumentLinkResolver } from "./in-memory-document-link-resolver.js";

registerDocumentLinkResolverContract("in-memory", async () => {
  const resolver = new InMemoryDocumentLinkResolver();
  return {
    resolver,
    async remember(candidate: DocumentLinkCandidate) {
      resolver.remember(candidate);
    },
  } satisfies DocumentLinkResolverContractHarness;
});
