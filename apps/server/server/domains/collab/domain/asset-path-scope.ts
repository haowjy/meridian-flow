/**
 * The document operations that serialize or parse Markdown, each run with its
 * project's image paths loaded fresh (see `ports/document-asset-paths.ts`).
 *
 * Text crosses these doors: the Markdown engine (reads, the read API and
 * download, writer and import writes, projections, link rewrites), the model's
 * edit core, a reply's save, the draft-aware hashline read, and offline
 * reconciliation. A push's settlement scopes itself in
 * `branch-push-transition.ts`. A picture serialized outside every scope is
 * reported (see `createUnscopedAssetPathObserver`).
 */

import type { BranchPeerShadowAccess, ResponseWriteFinalizer } from "../contracts.js";
import { asThreadPeerAgentEditCore, type ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { OfflineReconciliation } from "./offline-reconciliation.js";
import type { DocumentAssetPaths } from "./ports/document-asset-paths.js";

export function scopeMarkdownEngineAssetPaths(
  engine: MarkdownDocumentEngine,
  assetPaths: DocumentAssetPaths,
): MarkdownDocumentEngine {
  const by = (documentId: string) => ({ documentId });
  return {
    serializeDocument: (documentId, doc) =>
      assetPaths.within(by(documentId), () => engine.serializeDocument(documentId, doc)),
    serializeVersionedDocument: (documentId, doc) =>
      assetPaths.within(by(documentId), () => engine.serializeVersionedDocument(documentId, doc)),
    readVersionedMarkdown: (documentId) =>
      assetPaths.within(by(documentId), () => engine.readVersionedMarkdown(documentId)),
    restoreFromYDoc: (documentId, snapshot, origin) =>
      assetPaths.within(by(documentId), () => engine.restoreFromYDoc(documentId, snapshot, origin)),
    readAsMarkdown: (documentId) =>
      assetPaths.within(by(documentId), () => engine.readAsMarkdown(documentId)),
    setMarkdown: (input) =>
      assetPaths.within(by(input.documentId), () => engine.setMarkdown(input)),
    editMarkdown: (input) =>
      assetPaths.within(by(input.documentId), () => engine.editMarkdown(input)),
    seedFromMarkdown: (documentId, markdown, origin) =>
      assetPaths.within(by(documentId), () =>
        engine.seedFromMarkdown(documentId, markdown, origin),
      ),
    writeDocument: (input) =>
      assetPaths.within(by(input.documentId), () => engine.writeDocument(input)),
    editDocument: (input) =>
      assetPaths.within(by(input.documentId), () => engine.editDocument(input)),
  };
}

/**
 * A model call is scoped by its grant's project, which exists even for a
 * chapter the call is creating; a reversal by the document it reverses.
 */
export function scopeAgentEditAssetPaths(
  core: ThreadPeerAgentEditCore,
  assetPaths: DocumentAssetPaths,
): ThreadPeerAgentEditCore {
  const byGrant = (context: { grant: { facts: { projectId: string } } }) => ({
    projectId: context.grant.facts.projectId,
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
    read: (command, context) =>
      assetPaths.within(byGrant(context), () => core.read(command, context)),
    write: (command, context) =>
      assetPaths.within(byGrant(context), () => core.write(command, context)),
    undo: (docId, threadId) =>
      assetPaths.within({ documentId: docId }, () => core.undo(docId, threadId)),
    redo: (docId, threadId) =>
      assetPaths.within({ documentId: docId }, () => core.redo(docId, threadId)),
    reverse: (input) => assetPaths.within({ documentId: input.docId }, () => core.reverse(input)),
  });
}

/** A reply's save renders the receipts the model reads next, in its thread's project. */
export function scopeResponseFinalizerAssetPaths(
  finalizer: ResponseWriteFinalizer,
  assetPaths: DocumentAssetPaths,
): ResponseWriteFinalizer {
  return {
    finalizeResponseCommit: (responseId, ctx, beforeTransactionCommit) =>
      assetPaths.within({ threadId: ctx.threadId }, () =>
        finalizer.finalizeResponseCommit(responseId, ctx, beforeTransactionCommit),
      ),
    finalizeResponseRollback: (responseId, ctx) =>
      assetPaths.within({ threadId: ctx.threadId }, () =>
        finalizer.finalizeResponseRollback(responseId, ctx),
      ),
  };
}

/** Offline edits land in the change trail as text the writer reads back. */
export function scopeOfflineReconciliationAssetPaths(
  reconciliation: OfflineReconciliation,
  assetPaths: DocumentAssetPaths,
): OfflineReconciliation {
  return {
    reconcile: (input) =>
      assetPaths.within({ documentId: input.documentId }, () => reconciliation.reconcile(input)),
  };
}

export function scopeBranchPeerAssetPaths(
  access: BranchPeerShadowAccess,
  assetPaths: DocumentAssetPaths,
): BranchPeerShadowAccess {
  return {
    // Passed through: no Markdown of their own, or it comes from the scoped engine.
    readEffectiveRevision: access.readEffectiveRevision,
    pullThreadPeer: access.pullThreadPeer,
    flushBranchLivePull: access.flushBranchLivePull,
    readEffectiveMarkdown: access.readEffectiveMarkdown,
    resolveManifestMembership: access.resolveManifestMembership,
    reconcileProjectManifest: access.reconcileProjectManifest,
    recordManifestDocumentCreated: access.recordManifestDocumentCreated,
    recordManifestDocumentDeleted: access.recordManifestDocumentDeleted,
    readEffectiveHashlines: (command) =>
      assetPaths.within({ documentId: command.documentId }, () =>
        access.readEffectiveHashlines(command),
      ),
  };
}
