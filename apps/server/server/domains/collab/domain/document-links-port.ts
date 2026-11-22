/**
 * The server's `DocumentLinksPort` for one agent-edit core: the core names a
 * document and its write context, and this turns them into a holder and view
 * over the operation's document-link scope (contract §4.3–4.4).
 */
import { createHash } from "node:crypto";
import type {
  AheadMint,
  DocumentLinksPort,
  LoroLinksPort,
  WriteContext,
} from "@meridian/agent-edit/integration";
import { type LinkView, parseLinkRef } from "@meridian/contracts";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { cutRevision, viewRevision } from "./document-revision.js";
import { inLockedWrite } from "./locked-write.js";
import type {
  AheadRefRegistrar,
  DocumentLinkScopes,
  HolderLinkScope,
} from "./ports/document-link-scope.js";

export function createScopedDocumentLinks(input: {
  scopes: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
  /** The view a command on this document reads and writes in. */
  viewFor(documentId: string, context: WriteContext | undefined): LinkView;
  /** The draft whose view of Live the core reads; null for Live's. */
  draft: string | null;
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
        ...(request.context?.uploadsChat ? { uploadsChat: request.context.uploadsChat } : {}),
        stored: request.stored,
        refs: [...(request.shown ?? []).map((showing) => showing.ref), ...(request.refs ?? [])],
        addresses: request.addresses,
      }),
    scopeFor: (documentId, context) => scopes.holder(holder(documentId, context)),
    async registerAhead(mints) {
      if (mints.length === 0) return;
      const registrations = aheadRegistrations(mints);
      // A model edit mints under its lock, on its command's connection.
      if (inLockedWrite()) await input.registrar.registerInCommand(registrations);
      else await input.registrar.register(registrations);
    },
    revision: (doc, scope) => viewRevision(yjsRevision(doc, scope), input.draft),
  };
}

/** The same port for the Loro core, which reads and writes Live only (drafts are off). */
export function createScopedLoroDocumentLinks(input: {
  scopes: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
}): LoroLinksPort {
  return {
    ...createScopedDocumentLinks({ ...input, viewFor: liveViewFor, draft: null }),
    revision: cutRevision,
  };
}

/**
 * The Yjs core's revision: `y2:` + sha256 over the Yjs snapshot, the holder's URI and how every
 * ref-bearing link and `asset:` source spells. It goes with the Yjs core; the Loro one's is
 * `cutRevision`.
 */
function yjsRevision(doc: Y.Doc, scope: HolderLinkScope): string {
  const triples = new Set<string>();
  for (const occurrence of extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME))) {
    const asset = occurrence.kind !== "link" && occurrence.href.startsWith("asset:");
    if (occurrence.ref === null && !asset) continue;
    const spelled =
      occurrence.kind === "link"
        ? scope.spellLink({ href: occurrence.href, ref: occurrence.ref })
        : scope.spellSource({ src: occurrence.href, ref: occurrence.ref });
    triples.add(JSON.stringify([occurrence.ref, occurrence.href, spelled.href]));
  }
  return `y2:${createHash("sha256")
    .update(Y.encodeSnapshot(Y.snapshot(doc)))
    .update(Uint8Array.of(0))
    .update(scope.holder.uri ?? "", "utf8")
    .update(Uint8Array.of(0))
    .update(JSON.stringify([...triples].sort()), "utf8")
    .digest("base64url")}`;
}

/** The live utility core: every command reads and writes the live tree. */
export function liveViewFor(_documentId: string, _context: WriteContext | undefined): LinkView {
  return { kind: "live" };
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
