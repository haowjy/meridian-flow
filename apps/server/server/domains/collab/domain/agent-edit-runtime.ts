/** Shared agent-edit and markdown runtime construction for collab compositions. */
import {
  type AgentEditCodecFactory,
  createAgentEditCodecFactory,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentEdits,
  type UpdateJournal,
  type UpdateMeta,
  suggestingModel,
  type YProsemirrorDocumentModel,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { type Author, hiddenWorks } from "@meridian/suggestions";
import type { DocumentId, TurnId } from "@meridian/contracts/runtime";
import { mdxCodec, verbatimCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import { scopeMarkdownEngine } from "./document-link-scope-doors.js";
import { createScopedDocumentLinks, liveViewFor } from "./document-links-port.js";
import type { DocumentWriteHookRunner } from "./document-projection-refresher.js";
import { codeFiletypeOf } from "./document-schema-type.js";
import { createImportLinkBinder, createLinkBinder } from "./link-binding.js";
import {
  createMarkdownDocumentEngine,
  type MarkdownSerializationAnomalyObserver,
  type RuntimeOrigin,
} from "./markdown-document.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./ports/document-link-scope.js";
import type { InitialDocumentSeeds } from "./ports/initial-document-seeds.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";

type AgentEditObservability = Pick<
  Parameters<typeof createAgentEditCore>[0],
  "onUnexpectedWriteError" | "onLinkSpliceFallback" | "onObservationFailed"
>;

export function createAgentEditRuntime(input: {
  journal: UpdateJournal;
  documentEdits?: DocumentEdits;
  /** The live room door the Markdown engine and link binder work on. */
  coordinator: LiveDocumentCoordinator;
  /** The live agent-edit core's reads and saves (production delivers a save after commit). */
  agentCoordinator: DocumentCoordinator;
  initialDocumentSeeds: InitialDocumentSeeds;
  deferUntilCommit?(callback: () => void | Promise<void>): boolean;
  lockDocument?(documentId: DocumentId): Promise<void>;
  runDocumentWriteHook: DocumentWriteHookRunner;
  resolveDocumentFiletype(documentId: string): Promise<string | null>;
  observability: AgentEditObservability;
  /** How links and image sources spell, loaded per operation (contract §4.4). */
  links: DocumentLinkScopes;
  /** Durable ahead-ref registration for refs the model's writes mint. */
  aheadRefs: AheadRefRegistrar;
  observeSerializationAnomaly?: MarkdownSerializationAnomalyObserver;
  /** Whether a database transaction is open here; whole-document binding refuses to run in one. */
  inTransaction(): boolean;
}) {
  const schema = buildDocumentSchema();
  const markupCodec = mdxCodec({ schema });
  const codec = createAgentEditCodecFactory(markupCodec);
  const storedModel = yProsemirrorModel(schema);
  // Suggestion mode (prototype): every reader and the Live writer see the Live view; a Work's
  // write goes into Live as that Work's suggestions (`suggestionCore`).
  const suggestionMode = process.env.FLOW_SUGGESTIONS === "1";
  const model = suggestionMode
    ? suggestingModel(storedModel, (doc) => ({ work: null, hidden: hiddenWorks(doc) }), null)
    : storedModel;
  /** A code document's text is one code block, not Markdown: its codec reads and writes it so. */
  const codecFor = async (documentId: DocumentId): Promise<AgentEditCodecFactory> => {
    const filetype = await codeFiletypeOf(input.resolveDocumentFiletype, documentId);
    return filetype === null
      ? codec
      : createAgentEditCodecFactory(verbatimCodec(markupCodec, schema, filetype));
  };
  const liveCoreOver = (coreModel: YProsemirrorDocumentModel) =>
    createAgentEditCore({
      links: createScopedDocumentLinks({
        scopes: input.links,
        registrar: input.aheadRefs,
        viewFor: liveViewFor,
      }),
      journal: input.journal,
      documentEdits: input.documentEdits,
      coordinator: input.agentCoordinator,
      codec,
      codecFor,
      model: coreModel,
      ...input.observability,
    });
  const liveUtilityCore = asLiveAgentEditCore(liveCoreOver(model));
  /** A core over Live that reads a Work's view and, given an author, writes its suggestions. */
  const suggestionCore = suggestionMode
    ? (work: string, author: Author | null) =>
        liveCoreOver(
          suggestingModel(storedModel, (doc) => ({ work, hidden: hiddenWorks(doc) }), author),
        )
    : null;
  const markdownDocuments = scopeMarkdownEngine(
    createMarkdownDocumentEngine({
      codec: markupCodec,
      exportCodec: mdxCodec({ schema, export: true }),
      links: input.links,
      model,
      journal: input.journal,
      coordinator: input.coordinator,
      initialDocumentSeeds: input.initialDocumentSeeds,
      deferUntilCommit: input.deferUntilCommit,
      lockDocument: input.lockDocument,
      metaForOrigin,
      afterWrite: input.runDocumentWriteHook,
      identityPreservingWrite: ({ documentId, content, actor }) =>
        liveUtilityCore.write(
          {
            command: "create",
            file: "document",
            documentId,
            content: content.markdown,
            // Bound against the holder's document: overwrite it. Bound fresh: an empty one only.
            overwrite: !content.fresh,
          },
          {
            boundNodes: content.blocks,
            actor,
            sessionId:
              actor.kind === "human"
                ? actor.userId
                : actor.kind === "agent"
                  ? actor.turnId
                  : `system:${actor.origin}`,
            ...(actor.kind === "agent" || actor.kind === "human"
              ? { threadId: actor.threadId }
              : {}),
          },
        ),
      resolveFiletype: input.resolveDocumentFiletype,
      observeSerializationAnomaly: input.observeSerializationAnomaly,
    }),
    input.links,
  );
  const linkBinder = createLinkBinder({
    codec: markupCodec,
    schema,
    model,
    coordinator: input.coordinator,
    links: input.links,
    registrar: input.aheadRefs,
    resolveFiletype: input.resolveDocumentFiletype,
    inTransaction: input.inTransaction,
  });
  const importBinder = createImportLinkBinder({
    codec: markupCodec,
    schema,
    links: input.links,
    registrar: input.aheadRefs,
    resolveFiletype: input.resolveDocumentFiletype,
    inTransaction: input.inTransaction,
  });
  return {
    codec,
    codecFor,
    linkBinder,
    importBinder,
    liveUtilityCore,
    suggestionCore,
    markdownDocuments,
    markupCodec,
    model,
  };
}

export function metaForOrigin(origin: RuntimeOrigin): UpdateMeta {
  if (origin.type === "agent") {
    return { origin: `agent:${origin.actorTurnId}`, actorTurnId: origin.actorTurnId, seq: 0 };
  }
  if (origin.type === "user") {
    const userId = "actorUserId" in origin ? origin.actorUserId : origin.userId;
    return { origin: `human:${userId}`, seq: 0 };
  }
  if (origin.type === "import") {
    return origin.userId
      ? { origin: `human:${origin.userId}`, seq: 0 }
      : { origin: "system", seq: 0 };
  }
  return { origin: "system", seq: 0 };
}

export function attributionFromMeta(meta: UpdateMeta): {
  originType: string | null;
  actorTurnId: TurnId | null;
  actorUserId: import("@meridian/contracts/runtime").UserId | null;
} {
  if (meta.origin === "system") {
    return {
      originType: "system",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: null,
    };
  }
  const separator = meta.origin.indexOf(":");
  if (separator === -1) {
    return { originType: null, actorTurnId: null, actorUserId: null };
  }
  const kind = meta.origin.slice(0, separator);
  const id = meta.origin.slice(separator + 1);
  if (kind === "agent") {
    return {
      originType: "agent",
      actorTurnId: ((meta.actorTurnId ?? id) as TurnId) || null,
      actorUserId: null,
    };
  }
  if (kind === "human") {
    return {
      originType: "user",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: (id as import("@meridian/contracts/runtime").UserId) || null,
    };
  }
  return { originType: null, actorTurnId: null, actorUserId: null };
}
