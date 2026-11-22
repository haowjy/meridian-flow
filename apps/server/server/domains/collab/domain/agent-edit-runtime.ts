/** Shared agent-edit and markdown runtime construction for collab compositions. */
import {
  type AgentEditCodecFactory,
  type AgentEditCore,
  createAgentEditCodecFactory,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentEdits,
  suggestingModel,
  type UpdateJournal,
  type UpdateMeta,
  type YProsemirrorDocumentModel,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, TurnId } from "@meridian/contracts/runtime";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { mdxCodec, verbatimCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { type Author, liveView } from "@meridian/suggestions";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import { scopeMarkdownEngine } from "./document-link-scope-doors.js";
import { createScopedDocumentLinks, liveViewFor } from "./document-links-port.js";
import type { DocumentWriteHookRunner } from "./document-projection-refresher.js";
import { codeFiletypeOf } from "./document-schema-type.js";
import { createImportLinkBinder, createLinkBinder } from "./link-binding.js";
import { createMarkdownDocumentEngine, type RuntimeOrigin } from "./markdown-document.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./ports/document-link-scope.js";

type AgentEditObservability = Pick<
  Parameters<typeof createAgentEditCore>[0],
  "onUnexpectedWriteError" | "onLinkSpliceFallback" | "onObservationFailed"
>;

export function createAgentEditRuntime<Tx>(input: {
  journal: UpdateJournal;
  documentEdits?: DocumentEdits;
  /** The live agent-edit core's reads and saves (production delivers a save after commit). */
  agentCoordinator: DocumentCoordinator;
  lockDocument(documentId: DocumentId): Promise<void>;
  runDocumentWriteHook: DocumentWriteHookRunner;
  resolveDocumentFiletype(documentId: string): Promise<string | null>;
  observability: AgentEditObservability;
  /** How links and image sources spell, loaded per operation (contract §4.4). */
  links: DocumentLinkScopes;
  /** Durable ahead-ref registration for refs the model's writes mint. */
  aheadRefs: AheadRefRegistrar;
  /** The server's one door to document rooms: the Markdown engine reads and writes through it. */
  rooms: DocumentRooms<Tx>;
  /** Runs work in the caller's transaction, or in one of its own outside any. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Whether a database transaction is open here; whole-document binding refuses to run in one. */
  inTransaction(): boolean;
}) {
  const schema = buildDocumentSchema();
  const markupCodec = mdxCodec({ schema });
  const codec = createAgentEditCodecFactory(markupCodec);
  const storedModel = yProsemirrorModel(schema);
  // `model` is the Live view for every reader and writer of Live; it keeps every draft's
  // suggestions where they are. A draft's view is `draftView`, the one way the server reads a
  // draft or writes its suggestions. A version restore through `model` sets Live's text to the
  // version's and leaves every draft's pending suggestions where they are, except inside a block
  // the version lacks, which Live deletes with them, as the editor does.
  const model = suggestingModel(storedModel, liveView, null);
  /** A code document's text is one code block, not Markdown: its codec reads and writes it so. */
  const codecFor = async (documentId: DocumentId): Promise<AgentEditCodecFactory> => {
    const filetype = await codeFiletypeOf(input.resolveDocumentFiletype, documentId);
    return filetype === null
      ? codec
      : createAgentEditCodecFactory(verbatimCodec(markupCodec, schema, filetype));
  };
  const liveCoreOver = (coreModel: YProsemirrorDocumentModel, draft: string | null) =>
    createAgentEditCore({
      links: createScopedDocumentLinks({
        scopes: input.links,
        registrar: input.aheadRefs,
        // A draft's links spell in its tree, which its caller names.
        viewFor: draft
          ? (_documentId, context) => context?.linkView ?? { kind: "live" }
          : liveViewFor,
        draft,
      }),
      journal: input.journal,
      documentEdits: input.documentEdits,
      coordinator: input.agentCoordinator,
      codec,
      codecFor,
      model: coreModel,
      ...input.observability,
    });
  const liveUtilityCore = asLiveAgentEditCore(liveCoreOver(model, null));
  const draftView: DraftViews = {
    model: (draft) => suggestingModel(storedModel, { draft }, null),
    core: (draft, author) => liveCoreOver(suggestingModel(storedModel, { draft }, author), draft),
    onlyIn: (draft) => liveCoreOver(model, draft),
  };
  const markdownDocuments = scopeMarkdownEngine(
    createMarkdownDocumentEngine({
      schema,
      codec: markupCodec,
      exportCodec: mdxCodec({ schema, export: true }),
      links: input.links,
      rooms: input.rooms,
      transaction: input.transaction,
      lockDocument: input.lockDocument,
      afterWrite: input.runDocumentWriteHook,
      resolveFiletype: input.resolveDocumentFiletype,
    }),
    input.links,
  );
  const linkBinder = createLinkBinder({
    codec: markupCodec,
    schema,
    currentBlocks: markdownDocuments.currentBlocks,
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
    schema,
    codec,
    codecFor,
    linkBinder,
    importBinder,
    liveUtilityCore,
    draftView,
    markdownDocuments,
    markupCodec,
    model,
  };
}

/**
 * A draft's view of Live, Live plus that draft's suggestions. `model` only reads
 * it; `core` serves the model's tools, and its writes go into Live as the draft's suggestions by
 * `author`.
 */
export type DraftViews = {
  model(draft: string): YProsemirrorDocumentModel;
  core(draft: string, author: Author): AgentEditCore;
  /**
   * A document only this draft has (its create is pending there): its text is plain, so it writes
   * as Live does, but its links spell in the draft's tree and its revision is the draft's.
   */
  onlyIn(draft: string): AgentEditCore;
};

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
