/**
 * The document operations that serialize or parse Markdown for a reader, each
 * run with its project's image paths loaded fresh (see
 * `ports/document-asset-paths.ts`).
 *
 * Text crosses three doors: the Markdown engine (reads, the read API and
 * download, writer and import writes, projections, link rewrites), the model's
 * edit core, and the draft-aware hashline read. Codec calls elsewhere compare
 * a document with another version of itself, where the `asset:` spelling an
 * unscoped call gives is as good as a path.
 */

import type { BranchPeerShadowAccess } from "../contracts.js";
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
 * chapter the call is creating; a reversal by the document it reverses. A
 * reply's save renders the receipts the model reads afterwards, so it runs in
 * the project its calls ran in.
 */
export function scopeAgentEditAssetPaths(
  core: ThreadPeerAgentEditCore,
  assetPaths: DocumentAssetPaths,
): ThreadPeerAgentEditCore {
  const replyProjects = new Map<string, string>();
  function call<T>(
    context: { grant: { facts: { projectId: string } }; responseId?: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const { projectId } = context.grant.facts;
    if (context.responseId) replyProjects.set(context.responseId, projectId);
    return assetPaths.within({ projectId }, run);
  }
  return asThreadPeerAgentEditCore({
    ...core,
    read: (command, context) => call(context, () => core.read(command, context)),
    write: (command, context) => call(context, () => core.write(command, context)),
    async commitResponse(responseId, options) {
      const projectId = replyProjects.get(responseId);
      const saved = await (projectId
        ? assetPaths.within({ projectId }, () => core.commitResponse(responseId, options))
        : core.commitResponse(responseId, options));
      replyProjects.delete(responseId);
      return saved;
    },
    async rollbackResponse(responseId, ...rest) {
      const rolledBack = await core.rollbackResponse(responseId, ...rest);
      replyProjects.delete(responseId);
      return rolledBack;
    },
    undo: (docId, threadId) =>
      assetPaths.within({ documentId: docId }, () => core.undo(docId, threadId)),
    redo: (docId, threadId) =>
      assetPaths.within({ documentId: docId }, () => core.redo(docId, threadId)),
    reverse: (input) => assetPaths.within({ documentId: input.docId }, () => core.reverse(input)),
  });
}

export function scopeBranchPeerAssetPaths(
  access: BranchPeerShadowAccess,
  assetPaths: DocumentAssetPaths,
): BranchPeerShadowAccess {
  return {
    ...access,
    readEffectiveHashlines: (command) =>
      assetPaths.within({ documentId: command.documentId }, () =>
        access.readEffectiveHashlines(command),
      ),
  };
}
