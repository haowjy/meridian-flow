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
import type { EffectiveDocumentReader } from "../contracts.js";
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
    // The caller spells: a room copy is only text, and `serializeVersionedDocument` is scoped.
    readRoom: engine.readRoom,
    currentBlocks: engine.currentBlocks,
    serializeVersionedDocument: (documentId, doc, view) =>
      scopes.within(by(documentId), () => engine.serializeVersionedDocument(documentId, doc, view)),
    readVersionedMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readVersionedMarkdown(documentId)),
    readForExport: (documentId, scope) =>
      scopes.within(by(documentId), () => engine.readForExport(documentId, scope)),
    readAsMarkdown: (documentId) =>
      scopes.within(by(documentId), () => engine.readAsMarkdown(documentId)),
    seedFromMarkdown: (documentId, content, origin) =>
      scopes.within(by(documentId), () => engine.seedFromMarkdown(documentId, content, origin)),
    writeDocument: (input) =>
      scopes.within(by(input.documentId), () => engine.writeDocument(input)),
    writeCreatedContent: (input) =>
      scopes.within(by(input.documentId), () => engine.writeCreatedContent(input)),
    mergeCodeText: (input) =>
      scopes.within(by(input.documentId), () => engine.mergeCodeText(input)),
    // Neither spells a link: a seed is encoded from bound blocks.
    encodeSeed: engine.encodeSeed,
    installSeeds: engine.installSeeds,
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
 * Draft-aware reads, in the reader's thread: its draft and its reply's
 * staged creates decide what a draft view holds. The revision depends on the
 * tree, so it is scoped like the text.
 */
export function scopeEffectiveReader(
  access: Omit<EffectiveDocumentReader, "writeWorkCreatedContent">,
  scopes: DocumentLinkScopes,
  created: Pick<EffectiveDocumentReader, "writeWorkCreatedContent">,
): EffectiveDocumentReader {
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
    readDraftMarkdown: (command) =>
      scopes.within(by(command), () => access.readDraftMarkdown(command)),
    readEffectiveMarkdown: (command) =>
      scopes.within(by(command), () => access.readEffectiveMarkdown(command)),
    readEffectiveBlocks: (command) =>
      scopes.within(by(command), () => access.readEffectiveBlocks(command)),
    ...created,
    readEffectiveHashlines: (command) =>
      scopes.within(by(command), () => access.readEffectiveHashlines(command)),
  };
}
