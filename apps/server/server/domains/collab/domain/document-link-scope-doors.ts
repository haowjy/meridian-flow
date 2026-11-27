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
