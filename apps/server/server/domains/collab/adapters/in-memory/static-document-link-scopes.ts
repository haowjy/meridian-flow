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
    reader: ({ uri }) =>
      links.scopeFor(
        catalog?.documents.find((entry) => entry.uri === uri)?.documentId ?? "",
        undefined,
      ),
    draftCreatedAt: () => null,
    pinHolder: async ({ documentId, uri }) => {
      const entry = catalog?.documents.find((each) =>
        documentId ? each.documentId === documentId : each.uri === uri,
      );
      return entry ? { documentId: entry.documentId, uri: entry.uri } : null;
    },
  };
}

export const UNSUPPORTED_AHEAD_REFS: AheadRefRegistrar = {
  async register() {
    throw new Error("Ahead-ref registration is not supported in the in-memory composition");
  },
  async registerInCommand() {
    throw new Error("Ahead-ref registration is not supported in the in-memory composition");
  },
};
