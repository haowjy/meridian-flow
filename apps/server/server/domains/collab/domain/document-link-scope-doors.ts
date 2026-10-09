/**
 * The document operations that spell links and image sources, each run inside
 * a document-link scope (see `ports/document-link-scope.ts`). A door opens or
 * joins the snapshot; the operation itself prepares it with the documents it
 * is about to spell, because only it has loaded them.
 *
 * Text crosses these doors: the Markdown engine (reads, the read API and
 * download, writer and import writes, projections), the model's edit core, a
 * reply's save, the draft-aware reads (Markdown, hashlines and revision), offline
 * reconciliation, and a live turn's reversal. Draft preview scopes both sides
 * in `work-draft-review-service.ts`; ContextFS.search scopes its source's
 * chapters together. A push scopes itself before branch locks in
 * `branch-push.ts`, and its settlement in `branch-push-transition.ts`. Links
 * spelled outside every scope are reported (`createLinkScopeObserver`).
 */

import type { BranchPeerShadowAccess, ResponseWriteFinalizer } from "../contracts.js";
import {
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
  type ThreadPeerAgentEditCore,
} from "./agent-edit-cores.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { OfflineReconciliation } from "./offline-reconciliation.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

export function scopeMarkdownEngine(
  engine: MarkdownDocumentEngine,
  scopes: DocumentLinkScopes,
): MarkdownDocumentEngine {
  const by = (documentId: string) => ({ documentId });
  return {
    serializeDocument: (documentId, doc, view) =>
      scopes.within(by(documentId), () => engine.serializeDocument(documentId, doc, view)),
    serializeVersionedDocument: (documentId, doc, view) =>
      scopes.within(by(documentId), () => engine.serializeVersionedDocument(documentId, doc, view)),
    readVersionedMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readVersionedMarkdown(documentId)),
    restoreFromYDoc: (documentId, snapshot, origin) =>
      scopes.within(by(documentId), () => engine.restoreFromYDoc(documentId, snapshot, origin)),
    readAsMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readAsMarkdown(documentId)),
    setMarkdown: (input) => scopes.within(by(input.documentId), () => engine.setMarkdown(input)),
    seedFromMarkdown: (documentId, content, origin) =>
      scopes.within(by(documentId), () => engine.seedFromMarkdown(documentId, content, origin)),
    writeDocument: (input) =>
      scopes.within(by(input.documentId), () => engine.writeDocument(input)),
  };
}

/**
 * A model call is scoped by its grant's project, which exists even for a
 * chapter the call is creating, and read as the account it acts for; a
 * reversal by the document it reverses.
 */
export function scopeAgentEdit(
  core: ThreadPeerAgentEditCore,
  scopes: DocumentLinkScopes,
): ThreadPeerAgentEditCore {
  const byGrant = (context: {
    grant: { facts: { projectId: string }; principal: { accountId: string } };
    threadId?: string;
  }) => ({
    projectId: context.grant.facts.projectId,
    viewer: {
      accountId: context.grant.principal.accountId,
      ...(context.threadId ? { threadId: context.threadId } : {}),
    },
  });
  return asThreadPeerAgentEditCore({
    // Passed through: no Markdown of their own, or it comes from the scoped engine.
    recover: core.recover,
    // Saved and rolled back within the reply's thread, by the finalizer below.
    rollbackResponse: core.rollbackResponse,
    commitResponse: core.commitResponse,
    hasResponseDocument: core.hasResponseDocument,
    withResponseDocument: core.withResponseDocument,
    responseDocuments: core.responseDocuments,
    responseDestination: core.responseDestination,
    getAvailability: core.getAvailability,
    invalidateThread: core.invalidateThread,
    read: (command, context) => scopes.within(byGrant(context), () => core.read(command, context)),
    write: (command, context) =>
      scopes.within(byGrant(context), () => core.write(command, context)),
    undo: (docId, threadId) =>
      scopes.within({ documentId: docId }, () => core.undo(docId, threadId)),
    redo: (docId, threadId) =>
      scopes.within({ documentId: docId }, () => core.redo(docId, threadId)),
    reverse: (input) => scopes.within({ documentId: input.docId }, () => core.reverse(input)),
  });
}

/** A live turn's undo and redo snapshot every block of the document they reverse. */
export function scopeLiveReversal(
  core: LiveAgentEditCore,
  scopes: DocumentLinkScopes,
): Pick<LiveAgentEditCore, "reverse"> {
  return {
    reverse: (input) => scopes.within({ documentId: input.docId }, () => core.reverse(input)),
  };
}

/** A reply's save renders the receipts the model reads next, in its thread's project. */
export function scopeResponseFinalizer(
  finalizer: ResponseWriteFinalizer,
  scopes: DocumentLinkScopes,
): ResponseWriteFinalizer {
  return {
    finalizeResponseCommit: (responseId, ctx, beforeTransactionCommit) =>
      scopes.within({ threadId: ctx.threadId }, () =>
        finalizer.finalizeResponseCommit(responseId, ctx, beforeTransactionCommit),
      ),
    finalizeResponseRollback: (responseId, ctx) =>
      scopes.within({ threadId: ctx.threadId }, () =>
        finalizer.finalizeResponseRollback(responseId, ctx),
      ),
  };
}

/** Offline edits land in the change trail as text the writer reads back. */
export function scopeOfflineReconciliation(
  reconciliation: OfflineReconciliation,
  scopes: DocumentLinkScopes,
): OfflineReconciliation {
  return {
    reconcile: (input) =>
      scopes.within({ documentId: input.documentId }, () => reconciliation.reconcile(input)),
  };
}

/** Draft-aware reads; the revision now depends on the tree, so it is scoped like the text. */
export function scopeBranchPeer(
  access: BranchPeerShadowAccess,
  scopes: DocumentLinkScopes,
): BranchPeerShadowAccess {
  return {
    readEffectiveRevision: (command) =>
      scopes.within({ documentId: command.documentId }, () =>
        access.readEffectiveRevision(command),
      ),
    // Passed through: no Markdown of their own.
    pullThreadPeer: access.pullThreadPeer,
    flushBranchLivePull: access.flushBranchLivePull,
    readEffectiveMarkdown: (command) =>
      scopes.within({ documentId: command.documentId }, () =>
        access.readEffectiveMarkdown(command),
      ),
    resolveManifestMembership: access.resolveManifestMembership,
    reconcileProjectManifest: access.reconcileProjectManifest,
    recordManifestDocumentCreated: access.recordManifestDocumentCreated,
    recordManifestDocumentDeleted: access.recordManifestDocumentDeleted,
    readEffectiveHashlines: (command) =>
      scopes.within({ documentId: command.documentId }, () =>
        access.readEffectiveHashlines(command),
      ),
  };
}
