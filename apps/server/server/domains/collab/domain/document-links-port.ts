import type { AheadMint, DocumentLinksPort, WriteContext } from "@meridian/agent-edit/integration";
import { parseLinkRef } from "@meridian/contracts";
import { cutRevision } from "./document-revision.js";
import { inLockedWrite } from "./locked-write.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./ports/document-link-scope.js";

export function createScopedDocumentLinks(input: {
  scopes: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
}): DocumentLinksPort {
  const { scopes } = input;
  const holder = (documentId: string, context?: WriteContext) => ({
    documentId,
    view: context?.linkView ?? ({ kind: "live" } as const),
  });
  return {
    prepare: (request) =>
      scopes.prepare({
        holders: [holder(request.documentId, request.context)],
        written: request.written,
        ...(request.context?.uploadsChat ? { uploadsChat: request.context.uploadsChat } : {}),
        stored: request.stored,
        refs: [...(request.shown ?? []).map((showing) => showing.ref), ...(request.refs ?? [])],
        addresses: request.addresses,
      }),
    scopeFor: (documentId, context) => scopes.holder(holder(documentId, context)),
    async registerAhead(mints) {
      if (mints.length === 0) return;
      const registrations = aheadRegistrations(mints);
      if (inLockedWrite()) await input.registrar.registerInCommand(registrations);
      else await input.registrar.register(registrations);
    },
    revision: cutRevision,
  };
}

/**
 * The registry rows for minted ahead refs: each under the project its holder scope had,
 * and in the draft its holder was minted in (B7), so the draft's occupant settles it there.
 */
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
      ...(mint.view.kind === "draft" ? { draftId: mint.view.draftId } : {}),
    };
  });
}
