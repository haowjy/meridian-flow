/**
 * Document-link scopes over a fixed catalog, for compositions with no project
 * tree (in-memory, tests): every scope answers from the catalog, so nothing is
 * loaded and nothing is ever unscoped. An empty catalog spells every stored
 * href and `asset:` ref as stored.
 */
import {
  createStaticDocumentLinks,
  type StaticDocumentCatalog,
} from "@meridian/agent-edit/integration";
import type {
  AheadRefRegistrar,
  DocumentLinkScopes,
} from "../../domain/ports/document-link-scope.js";

export function createStaticDocumentLinkScopes(
  catalog?: StaticDocumentCatalog,
): DocumentLinkScopes {
  const links = createStaticDocumentLinks(catalog);
  return {
    within: (_key, operation) => operation(),
    prepare: async () => {},
    holder: ({ documentId }) => links.scopeFor(documentId, undefined),
  };
}

/** No registry in memory: a write that mints an ahead ref fails loudly instead of losing it. */
export const UNSUPPORTED_AHEAD_REFS: AheadRefRegistrar = {
  async register() {
    throw new Error("Ahead-ref registration is not supported in the in-memory composition");
  },
};
