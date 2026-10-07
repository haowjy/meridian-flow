/**
 * The document operations that serialize or parse Markdown for a reader, each
 * run with its project's image paths loaded fresh (see
 * `ports/document-asset-paths.ts`).
 *
 * Text crosses four doors: the Markdown engine (reads, the read API and
 * download, writer and import writes, projections, link rewrites), the model's
 * edit core, a reply's save, and the draft-aware hashline read. Codec calls elsewhere compare
 * a document with another version of itself, where the `asset:` spelling an
 * unscoped call gives is as good as a path.
 */

import type { BranchPeerShadowAccess, ResponseWriteFinalizer } from "../contracts.js";
import { asThreadPeerAgentEditCore, type ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
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
