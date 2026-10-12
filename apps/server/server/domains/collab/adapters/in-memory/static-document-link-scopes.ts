/**
 * Document-link scopes over a fixed catalog, for compositions with no project
 * tree (in-memory, tests): every scope answers from the catalog (preloaded), so nothing is
 * loaded and nothing is ever unscoped. An empty catalog spells every stored
 * href as stored and every `asset:` source as an empty destination.
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
  const links = createStaticDocumentLinks(catalog, { preloaded: true });
  return {
    within: (_key, operation) => operation(),
    prepare: async () => {},
    holder: ({ documentId }) => links.scopeFor(documentId, undefined),
    // Resolution never reads the holder, so a reader outside the catalog spells from no holder.
    reader: ({ uri }) =>
      links.scopeFor(
        catalog?.documents.find((entry) => entry.uri === uri)?.documentId ?? "",
        undefined,
      ),
  };
}

/** No registry in memory: a write that mints an ahead ref fails loudly instead of losing it. */
export const UNSUPPORTED_AHEAD_REFS: AheadRefRegistrar = {
  async register() {
    throw new Error("Ahead-ref registration is not supported in the in-memory composition");
  },
};
