/** Explicit in-memory collab composition and behavior-preserving unsupported stubs. */

import type {
  AgentEditCodecFactory,
  LoroDocumentEdits,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { agentEditRooms, toDocHandle } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createMemoryDocumentRooms } from "@meridian/document-model/rooms";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { Ok } from "../../../../shared/result.js";
import { createCheckpointService } from "../../checkpoints.js";
import { createCollabFacade } from "../../collab-facade.js";
import type {
  CollabDomain,
  CollabDrafts,
  EffectiveDocumentReader,
  ServerDocumentRooms,
} from "../../contracts.js";
import { createAgentEditRouter } from "../../domain/agent-edit-router.js";
import {
  attributionFromMeta,
  createAgentEditRuntime,
  metaForOrigin,
} from "../../domain/agent-edit-runtime.js";
import { createDocumentCreationAggregate } from "../../domain/document-creation.js";
import { createDocumentWriteHookRunner } from "../../domain/document-projection-refresher.js";
import { readHashlines, versioned } from "../../domain/document-revision.js";
import { isCodeDocument } from "../../domain/document-schema-type.js";
import { createDrafts } from "../../domain/drafts.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "../../domain/ports/document-link-scope.js";
import { createTurnLiveLineageReadModel } from "../../domain/turn-live-lineage.js";
import { createHocuspocusPersistenceService } from "../../hocuspocus-persistence.js";
import { createAgentEditObservabilityOptions } from "../agent-edit-observability.js";
import {
  SILENT_DOCUMENT_PROJECTION_DIAGNOSTICS,
  UNSUPPORTED_REVERSE_THREAD_CONTEXT,
} from "../declared-stubs.js";
import { createHocuspocusBinding } from "../hocuspocus-binding.js";
import {
  createInMemoryCoordinator,
  createInMemoryJournal,
  type InMemoryJournal,
} from "./agent-edit.js";
import {
  createInMemoryDraftStore,
  createInMemoryDraftWriteBoundary,
  type NamedDraft,
} from "./drafts.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "./static-document-link-scopes.js";

/** `namedDraft` reads the draft a Work's or root chat's row names; by default nothing names one. */
export function createInMemoryCollabDomain(
  namedDraft: NamedDraft = async () => null,
): CollabDomain {
  // Nothing in memory carries a filetype: every document is prose.
  const resolveDocumentFiletype = async () => null;
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => operation(),
  });
  const hocuspocusBinding = createHocuspocusBinding();
  const store = inMemoryStore(journal);
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: async () => {},
    diagnostics: SILENT_DOCUMENT_PROJECTION_DIAGNOSTICS,
  });
  const links = createStaticDocumentLinkScopes();
  const rooms = memoryServerRooms();
  const runtime = createAgentEditRuntime({
    loro: {
      rooms: agentEditRooms(rooms, {
        roomFor: async (documentId) => ({ kind: "live", documentId }),
        // The memory rooms run each commit as its own transaction.
        transaction: () => null as unknown as DrizzleDb,
        origin: "server:agent",
        // Nothing in memory keeps an edit history.
        recordWrite: async () => {},
      }),
      documentEdits: NO_EDIT_HISTORY,
      authorOfTurn: async () => null,
    },
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    inTransaction: () => false,
    journal,
    coordinator,
    agentCoordinator: coordinator,
    initialDocumentSeeds: {
      async discardUnbornDocuments() {},
      seedInitialDocument: (documentId, state) => journal.seedInitialDocument(documentId, state),
      async seedInitialDocuments(seeds) {
        for (const { documentId, state } of seeds)
          await journal.seedInitialDocument(documentId, state);
      },
      async lacksAuthority(documentId) {
        const snapshot = await journal.read(documentId);
        return !snapshot.checkpoint && snapshot.updates.length === 0;
      },
    },
    runDocumentWriteHook,
    resolveDocumentFiletype,
    observability: createAgentEditObservabilityOptions({}),
  });
  const drafts = createDrafts({
    store: createInMemoryDraftStore(namedDraft),
    boundary: createInMemoryDraftWriteBoundary(),
  });
  const agentEdit = createAgentEditRouter({
    liveCore: runtime.liveCore,
    liveUtilityCore: runtime.liveUtilityCore,
    draftView: runtime.draftView,
  });
  const projections = { refresh: runDocumentWriteHook };
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal,
    hocuspocus: hocuspocusBinding.current,
    metaForOrigin,
  });
  const lineage = createTurnLiveLineageReadModel({
    store: createInMemoryTurnLiveLineageStore(journal),
    resolveDocumentUri: async (documentId) => documentId,
    resolveLastDocumentUri: async (documentId) => documentId,
  });
  const checkpoints = createCheckpointService({
    coordinator,
    store,
    journal: journal,
    markdownDocuments: runtime.markdownDocuments,
  });

  return createCollabFacade({
    importBinder: runtime.importBinder,
    lifecycle: { dispose: async () => {} },
    transport: {
      rooms,
      documentSchemaVersion: async () => null,
      onRoomsEnded: () => () => undefined,
      bindHocuspocus: hocuspocusBinding.bind,
      headSchemaVersion: async () => null,
      loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,
      admitLiveWriterUpdate: hocuspocusPersistence.admitLiveWriterUpdate,
      // Nothing is removed in memory.
      draftsHolding: async () => [],
      roomRemoval: async () => null,
      validateHocuspocusDocument: hocuspocusPersistence.validateHocuspocusDocument,
      storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,
      drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,
      getPersistenceQueueMetrics: hocuspocusPersistence.getPersistenceQueueMetrics,
    },
    agentEdit: {
      agentEdit: () => agentEdit,
      modelEdits: () => {
        throw new Error("Model edits require the command-backed Postgres adapter");
      },
      modelEvidence: () => {
        throw new Error("Model evidence requires the Postgres adapter");
      },
      treeHistory: () => {
        throw new Error("Tree history requires the receipt-backed Postgres adapter");
      },
    },
    reversal: {
      reverseTurn: async () => {
        throw new Error("Turn receipts require the durable Postgres receipt adapter");
      },
      reverseThreadContext: UNSUPPORTED_REVERSE_THREAD_CONTEXT,
    },
    documents: {
      readForExport: runtime.markdownDocuments.readForExport,
      ensureDocumentAuthority: runtime.markdownDocuments.ensureDocumentAuthority,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readFrozenMarkdown: runtime.markdownDocuments.readFrozenMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      async discardUnbornDocuments() {},
      encodeSeed: runtime.markdownDocuments.encodeSeed,
      installSeeds: runtime.markdownDocuments.installSeeds,
      writeDocument: runtime.markdownDocuments.writeDocument,
      mergeCodeText: runtime.markdownDocuments.mergeCodeText,
      withLiveDocument: runtime.markdownDocuments.withLiveDocument,
      writeDocumentHeld: runtime.markdownDocuments.writeDocumentHeld,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
      bindCopiedBlocks: runtime.linkBinder.bindCopiedBlocks,
      bindStatic: runtime.linkBinder.bindStatic,
    },
    projections: {
      refreshDocumentProjection: projections.refresh,
      documentDerivations: {
        derive: async (documentId) => {
          await projections.refresh({ documentId });
          return { status: "missing" };
        },
        schedule: () => {},
        sweep: async () => 0,
        stop: async () => {},
      },
    },
    lineage,
    checkpoints,
    attribution: {
      async getLastUpdateAttribution(documentId) {
        const latest = await store.latestUpdate(documentId);
        if (!latest) {
          return { originType: null, actorTurnId: null, actorUserId: null, updateSeq: null };
        }
        return { ...attributionFromMeta(latest.meta), updateSeq: latest.seq };
      },
    },
    effectiveReader: createInMemoryEffectiveReaderStub(
      runtime.markdownDocuments,
      coordinator,
      runtime.model,
      runtime.codec,
      links,
      resolveDocumentFiletype,
    ),
    drafts: createInMemoryDraftStub(),
    draftResolver: {
      drafts,
      // No drafts in memory: a purged Work has none to dispose of.
      workDraftDisposal: {
        withDisposal: (_workId, run) => run(async () => ({ releasedObjects: [], draftIds: [] })),
      },
      documentPurgeDisposal: { settle: async () => "closed" },
    },
    documentCreation,
  });
}

function createInMemoryEffectiveReaderStub(
  documents: {
    readVersionedMarkdown(
      documentId: string,
    ): ReturnType<
      import("../../domain/markdown-document.js").MarkdownDocumentEngine["readVersionedMarkdown"]
    >;
  },
  coordinator: {
    withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
  },
  model: YProsemirrorDocumentModel,
  codec: AgentEditCodecFactory,
  links: DocumentLinkScopes,
  resolveFiletype: (documentId: DocumentId) => Promise<string | null>,
): EffectiveDocumentReader {
  return {
    async readEffectiveRevision(input) {
      const read = await documents.readVersionedMarkdown(input.documentId);
      return read.ok ? read.value.revision : null;
    },
    // Nothing is derived in memory.
    readStoredGrepTexts: async () => new Map(),
    readStoredWordCounts: async () => new Map(),
    readDraftMarkdown: (input) => documents.readVersionedMarkdown(input.documentId),
    readEffectiveMarkdown: (input) => documents.readVersionedMarkdown(input.documentId),
    readEffectiveBlocks: (input) =>
      coordinator.withDocument(input.documentId, async (doc) => {
        const scope = links.holder({ documentId: input.documentId, view: LIVE_VIEW });
        return Ok({
          content: model.projectBlocks(toDocHandle(doc)).map((block) => block.node),
          version: "live" as const,
          revision: versioned(doc, scope, () => null).revision,
          holderUri: scope.holder.uri,
          stateVector: Y.encodeStateVector(doc),
          // The in-memory link scopes never settle an ahead ref.
          aheadSettlements: new Map<string, string>(),
        });
      }),
    readEffectiveHashlines: (input) =>
      coordinator.withDocument(input.documentId, async (doc) => {
        const scope = links.holder({ documentId: input.documentId, view: LIVE_VIEW });
        const verbatim = await isCodeDocument(resolveFiletype, input.documentId);
        return Ok(readHashlines(doc, scope, model, codec, verbatim));
      }),
    async writeWorkCreatedContent() {
      throw new Error("Work creates need Postgres; the in-memory collab domain has no drafts");
    },
    async seedWorkCreates() {
      throw new Error("Draft creates need Postgres; the in-memory collab domain has no drafts");
    },
  };
}

function createInMemoryDraftStub(): CollabDrafts {
  const unsupported = async (): Promise<never> => {
    throw new Error("The press needs Postgres; the in-memory collab domain has no Works");
  };
  return {
    presses: { press: unsupported, undo: unsupported },
    draftReview: {
      async purgeDiscards() {
        return 0;
      },
      async list() {
        return [];
      },
      async listItems() {
        return { items: [], folders: [], threadTitles: new Map(), saw: {} };
      },
      async pendingDocumentCount() {
        return 0;
      },
      async draftsChangingDocument() {
        return [];
      },
      async items({ draft }) {
        return { draftId: draft, items: [] };
      },
      async resolveItem() {
        return null;
      },
      async resolveItemInDraft() {
        return null;
      },
      async lookupCommand() {
        return { kind: "none" };
      },
      async awaitCommand() {
        return { kind: "none" };
      },
    },
  };
}

function createInMemoryTurnLiveLineageStore(journal: InMemoryJournal) {
  return {
    async listLiveDocumentIdsForTurn(threadId: string, turnId: string) {
      return (await journal.documentsForTurn(threadId, turnId)) as DocumentId[];
    },
    async listEditedDocumentIdsForTurn(threadId: string, turnId: string) {
      return (await journal.documentsForTurn(threadId, turnId)).map((documentId) => ({
        documentId: documentId as DocumentId,
        scope: "live" as const,
      }));
    },
    // The in-memory host has no tree history.
    async listFolderTargetsForTurn() {
      return [];
    },
    async placesOf() {
      return new Map();
    },
    async listTreeEntriesForTurn() {
      return [];
    },
  };
}

function inMemoryStore(journal: InMemoryJournal) {
  return {
    createCheckpoint: journal.createCheckpoint.bind(journal),
    getCheckpoint: (id: string) => journal.getCheckpoint(id),
    listCheckpoints: (docId: string) => journal.listCheckpoints(docId),
    latestUpdate: (docId: string) => journal.latestUpdate(docId),
    latestUpdateSeq: (docId: string) => journal.latestUpdateSeq(docId),
  };
}

/** The in-memory rooms behind the server's door: each commit or seed is its own transaction. */
const NO_EDIT_HISTORY: LoroDocumentEdits = {
  read: async () => ({ status: "invalid_write", message: "This host has no edit history." }),
  execute: async () => ({ status: "invalid_write", message: "This host has no edit history." }),
};

function memoryServerRooms(): ServerDocumentRooms {
  const memory = createMemoryDocumentRooms(shapeSchemaOf(buildDocumentSchema()));
  return {
    read: memory.read,
    sync: memory.sync,
    write: memory.write,
    commit: (_tx, room, batch, origin) =>
      memory.transaction((tx) => memory.commit(tx, room, batch, origin)),
    seed: (_tx, room, snapshots) => memory.transaction((tx) => memory.seed(tx, room, snapshots)),
    subscribe: memory.subscribe,
    flush: memory.flush,
    unload: memory.unload,
    close: memory.close,
  };
}
