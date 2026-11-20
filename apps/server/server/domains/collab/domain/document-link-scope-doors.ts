/**
 * The document operations that spell links and image sources, each run inside
 * a document-link scope (see `ports/document-link-scope.ts`). A door opens or
 * joins the snapshot; the operation itself prepares it with the documents it
 * is about to spell, because only it has loaded them.
 *
 * Text crosses these doors: the Markdown engine (reads, the read API and
 * download, writer and import writes), the model's edit core and draft-aware reads (Markdown, hashlines and revision).
 * ContextFS.search scopes its source's chapters together. Links
 * spelled outside every scope are reported (`createLinkScopeObserver`).
 */

import type { FileGrant } from "../../file-policy/index.js";
import type { DraftPeerShadowAccess } from "../contracts.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ModelEdits } from "./model-edit.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

export function scopeMarkdownEngine(
  engine: MarkdownDocumentEngine,
  scopes: DocumentLinkScopes,
): MarkdownDocumentEngine {
  const by = (documentId: string) => ({ documentId });
  return {
    serializeDocument: (documentId, doc, view) =>
      scopes.within(by(documentId), () => engine.serializeDocument(documentId, doc, view)),
    serializeVersionedDocument: (documentId, doc, view, model) =>
      scopes.within(by(documentId), () =>
        engine.serializeVersionedDocument(documentId, doc, view, model),
      ),
    readFrozenMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readFrozenMarkdown(documentId)),
    readVersionedMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readVersionedMarkdown(documentId)),
    restoreFromYDoc: (documentId, snapshot, origin) =>
      scopes.within(by(documentId), () => engine.restoreFromYDoc(documentId, snapshot, origin)),
    readForExport: (documentId, scope) =>
      scopes.within(by(documentId), () => engine.readForExport(documentId, scope)),
    readAsMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readAsMarkdown(documentId)),
    setMarkdown: (input) => scopes.within(by(input.documentId), () => engine.setMarkdown(input)),
    seedFromMarkdown: (documentId, content, origin) =>
      scopes.within(by(documentId), () => engine.seedFromMarkdown(documentId, content, origin)),
    writeDocument: (input) =>
      scopes.within(by(input.documentId), () => engine.writeDocument(input)),
    changeLiveDocument: (input) =>
      scopes.within(by(input.documentId), () => engine.changeLiveDocument(input)),
    mergeCodeText: (input) =>
      scopes.within(by(input.documentId), () => engine.mergeCodeText(input)),
    // None spells a link: a seed is encoded from bound blocks, and authority repair seeds an
    // empty document.
    encodeSeed: engine.encodeSeed,
    installSeeds: engine.installSeeds,
    ensureDocumentAuthority: engine.ensureDocumentAuthority,
    // The lease spells nothing; the held write spells as the document it admits.
    withLiveDocument: engine.withLiveDocument,
    writeDocumentHeld: (input) =>
      scopes.within(by(input.held.documentId), () => engine.writeDocumentHeld(input)),
  };
}

/**
 * The project a model edit's links read in: the request's, never the file's (a home document has
 * none). An agent's is its thread's project; a writer's (a card's Undo) is the thread's it runs in.
 */
function requestScope(context: {
  grant: FileGrant;
  threadId?: string | undefined;
}): { projectId: string } | { threadId: string } {
  const projectId = context.grant.principal.agent?.projectId;
  if (projectId) return { projectId };
  if (context.threadId) return { threadId: context.threadId };
  throw new Error("A model edit runs in no thread and no agent's project");
}

/**
 * A model read is scoped by its request's project, which exists even for a chapter the call is
 * creating; it reads as the account it acts for, in the thread it reads in.
 */
export function scopeAgentEdit(
  router: AgentEditRouter,
  scopes: DocumentLinkScopes,
): AgentEditRouter {
  return {
    // Passed through: no Markdown of their own, or it comes from the scoped engine.
    readRoom: router.readRoom,
    read: (command, context) =>
      scopes.within(
        {
          ...requestScope(context),
          viewer: {
            accountId: context.grant.principal.accountId,
            ...(context.threadId ? { threadId: context.threadId } : {}),
          },
        },
        () => router.read(command, context),
      ),
  };
}

/** A model edit's write is scoped by its request's project and its thread. */
export function scopeModelEditWrite(
  write: ModelEdits["write"],
  scopes: DocumentLinkScopes,
): ModelEdits["write"] {
  return (command, context) =>
    scopes.within(
      {
        ...requestScope(context),
        viewer: {
          accountId: context.grant.principal.accountId,
          ...(context.threadId ? { threadId: context.threadId } : {}),
        },
      },
      () => write(command, context),
    );
}

/**
 * Draft-aware reads, in the reader's thread: its manifest peer and reply's
 * staged creates decide what a branch view holds. The revision depends on the
 * tree, so it is scoped like the text.
 */
export function scopeDraftPeer(
  access: Omit<DraftPeerShadowAccess, "seedWorkCreates" | "writeWorkCreatedContent">,
  scopes: DocumentLinkScopes,
  created: Pick<DraftPeerShadowAccess, "seedWorkCreates" | "writeWorkCreatedContent">,
): DraftPeerShadowAccess {
  const by = (command: { documentId: string; threadId?: string | null }) => ({
    documentId: command.documentId,
    ...(command.threadId ? { viewer: { threadId: command.threadId } } : {}),
  });
  return {
    readEffectiveRevision: (command) =>
      scopes.within(by(command), () => access.readEffectiveRevision(command)),
    // Passed through: no Markdown of their own.
    readStoredGrepTexts: access.readStoredGrepTexts,
    readStoredWordCounts: access.readStoredWordCounts,
    readOwnerMarkdown: (command) =>
      scopes.within(by(command), () => access.readOwnerMarkdown(command)),
    readEffectiveMarkdown: (command) =>
      scopes.within(by(command), () => access.readEffectiveMarkdown(command)),
    readEffectiveBlocks: (command) =>
      scopes.within(by(command), () => access.readEffectiveBlocks(command)),
    ...created,
    readEffectiveHashlines: (command) =>
      scopes.within(by(command), () => access.readEffectiveHashlines(command)),
  };
}
