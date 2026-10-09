/**
 * The server's `DocumentLinksPort` for one agent-edit core: the core names a
 * document and its write context, and this turns them into a holder and view
 * over the operation's document-link scope (contract §4.3–4.4).
 */
import type { AheadMint, DocumentLinksPort, WriteContext } from "@meridian/agent-edit/integration";
import { type LinkView, parseLinkRef } from "@meridian/contracts";
import { documentRevision } from "./document-revision.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./ports/document-link-scope.js";

export function createScopedDocumentLinks(input: {
  scopes: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
  /** The view a command on this document reads and writes in. */
  viewFor(documentId: string, context: WriteContext | undefined): LinkView;
}): DocumentLinksPort {
  const { scopes } = input;
  const holder = (documentId: string, context: WriteContext | undefined) => ({
    documentId,
    view: input.viewFor(documentId, context),
  });
  return {
    prepare: (request) =>
      scopes.prepare({
        holders: [holder(request.documentId, request.context)],
        docs: request.docs,
        written: request.written,
        stored: request.stored,
        refs: [...(request.shown ?? []).map((showing) => showing.ref), ...(request.refs ?? [])],
        addresses: request.addresses,
      }),
    scopeFor: (documentId, context) => scopes.holder(holder(documentId, context)),
    async registerAhead(mints) {
      if (mints.length > 0) await input.registrar.register(aheadRegistrations(mints));
    },
    revision: documentRevision,
  };
}

/** The live utility core: every command reads and writes the live tree. */
export function liveViewFor(_documentId: string, context: WriteContext | undefined): LinkView {
  return context?.responseId ? { kind: "live", responseId: context.responseId } : { kind: "live" };
}

/** The registry rows for minted ahead refs: each under the project its holder scope had. */
export function aheadRegistrations(mints: readonly AheadMint[]) {
  return mints.map((mint) => {
    const parsed = parseLinkRef(mint.ref);
    if (parsed?.kind !== "ahead") throw new RangeError(`Not an ahead ref: ${mint.ref}`);
    // An unscoped holder has no project; the registry would only fail later on the query.
    if (!mint.holderProjectId) throw new RangeError(`Ahead ref ${mint.ref} has no holder project`);
    return {
      aheadId: parsed.aheadId,
      holderProjectId: mint.holderProjectId,
      address: mint.address,
    };
  });
}
