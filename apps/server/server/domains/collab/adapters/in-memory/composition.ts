/** Explicit in-memory collab composition and behavior-preserving unsupported stubs. */

import {
  type AgentEditCodecFactory,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { spelledLinks } from "@meridian/markup/links";
import * as Y from "yjs";
import { Ok } from "../../../../shared/result.js";
import { createAllowAllFileAccess } from "../../../file-policy/index.js";
import { createCheckpointService } from "../../checkpoints.js";
import { createCollabFacade } from "../../collab-facade.js";
import type {
  CollabBranches,
  CollabDomain,
  CommandOutcome,
  DraftPeerShadowAccess,
} from "../../contracts.js";
import {
  attributionFromMeta,
  createAgentEditRuntime,
  metaForOrigin,
} from "../../domain/agent-edit-runtime.js";
import { createBranches } from "../../domain/branches.js";
import { createDocumentCreationAggregate } from "../../domain/document-creation.js";
import { createDocumentWriteHookRunner } from "../../domain/document-projection-refresher.js";
import { versioned } from "../../domain/document-revision.js";
import { DraftNotFoundError } from "../../domain/draft-resolver.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "../../domain/ports/document-link-scope.js";
import { primeReservedNamespaceIndex } from "../../domain/provenance.js";
import { createReplySaveFences } from "../../domain/reply-save-fences.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "../../domain/response-transaction.js";
import { createResponseWriteFinalizer } from "../../domain/response-write-finalizer.js";
import { createThreadPeerCorePool } from "../../domain/thread-peer-core-pool.js";
import { createTurnLiveLineageReadModel } from "../../domain/turn-live-lineage.js";
import { createHocuspocusPersistenceService } from "../../hocuspocus-persistence.js";
import { createAgentEditObservabilityOptions } from "../agent-edit-observability.js";
import {
  SILENT_DOCUMENT_PROJECTION_DIAGNOSTICS,
  SILENT_POST_DURABILITY_NOTICES,
  UNSUPPORTED_REVERSE_THREAD_CONTEXT,
} from "../declared-stubs.js";
import { createHocuspocusBinding } from "../hocuspocus-binding.js";
import {
  createInMemoryCoordinator,
  createInMemoryJournal,
  type InMemoryJournal,
} from "./agent-edit.js";
import { createInMemoryBranchStore, createInMemoryBranchWriteBoundary } from "./branches.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "./static-document-link-scopes.js";

export function createInMemoryCollabDomain(): CollabDomain {
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
  const runtime = createAgentEditRuntime({
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    inTransaction: () => false,
    journal,
    coordinator,
    agentCoordinator: coordinator,
    initialDocumentSeeds: {
      seedInitialDocument: (documentId, state) => journal.seedInitialDocument(documentId, state),
      async missingAuthorityProjection(documentId) {
        const snapshot = await journal.read(documentId);
        return snapshot.checkpoint || snapshot.updates.length > 0 ? null : "";
      },
    },
    runDocumentWriteHook,
    resolveDocumentFiletype: async () => null,
    observability: createAgentEditObservabilityOptions({}),
  });
  const branches = createBranches({
    store: createInMemoryBranchStore(),
    boundary: createInMemoryBranchWriteBoundary(),
  });
  // No Work branches exist in memory, so the pool routes both destinations to the live core.
  const fileAccess = createAllowAllFileAccess();
  // Nothing is removed in memory.
  const removals = { lookup: async () => new Map() };
  const agentEdit = createThreadPeerCorePool({
    branches,
    removals,
    drafts: {
      getDraft: async () => null,
      resolveWorkDraftForThread: (documentId, threadId) =>
        Promise.reject(new DraftNotFoundError(documentId, threadId)),
    },
    liveUtilityCore: runtime.liveUtilityCore,
    createThreadCore: () => runtime.liveUtilityCore,
    // Thread cores are the live core here: no write asks for a thread peer.
    ensureThreadPeer: () => Promise.reject(new Error("In-memory collab has no thread peers")),
    // Thread cores are the live core here, so nothing is ever pinned to a branch.
    fences: createReplySaveFences({
      liveUtilityCore: runtime.liveUtilityCore,
      drafts: { getDraft: async () => null },
      branches,
      fileAccess,
      removals,
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
    }),
    commitThreadResponseAtomically: (operation) => operation(),
    attemptScope: (operation) => operation(),
    responseTransactionSettlement: {
      deferUntilCommit: () => false,
      deferUntilRollback: () => false,
    },
    responseTransactions: { enlist: enlistResponseParticipant, run: runResponseTransaction },
    fileAccess,
    lockWorks: async () => {},
    lockLiveDocuments: async () => {},
  });
  const projections = { refresh: runDocumentWriteHook };
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal,
    hocuspocus: hocuspocusBinding.current,
    metaForOrigin,
    emitAgentEditInvariantViolation() {},
  });
  const lineage = createTurnLiveLineageReadModel({
    store: createInMemoryTurnLiveLineageStore(journal),
    resolveDocumentUri: async (documentId) => documentId,
    resolveLastDocumentUri: async (documentId) => documentId,
  });
  const responseFinalizer = createResponseWriteFinalizer({
    agentEdit,
    rollback: {
      async rollbackResponse() {
        throw new Error("Durable inverse rollback requires the receipt-backed Postgres adapter");
      },
    },
    projections,
    notices: SILENT_POST_DURABILITY_NOTICES,
  });
  const checkpoints = createCheckpointService({
    coordinator,
    store,
    journal: journal,
    markdownDocuments: runtime.markdownDocuments,
  });

  return createCollabFacade({
    lifecycle: { dispose: async () => {} },
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      primeReservedNamespaceIndex,
      headSchemaVersion: async () => null,
      resolveDraftHocuspocusRoom: hocuspocusPersistence.resolveDraftHocuspocusRoom,
      loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,
      loadHocuspocusDraftState: hocuspocusPersistence.loadHocuspocusDraftState,
      admitLiveWriterUpdate: hocuspocusPersistence.admitLiveWriterUpdate,
      currentLiveGeneration: hocuspocusPersistence.currentLiveGeneration,
      // Nothing is removed in memory.
      roomRemoval: async () => null,
      validateHocuspocusDocument: hocuspocusPersistence.validateHocuspocusDocument,
      admitDraftWriterUpdate: hocuspocusPersistence.admitDraftWriterUpdate,
      storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,
      storeHocuspocusDraft: hocuspocusPersistence.storeHocuspocusDraft,
      drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,
      drainHocuspocusDraftPersistence: hocuspocusPersistence.drainHocuspocusDraftPersistence,
      closeHocuspocusDraftRoom: hocuspocusPersistence.closeHocuspocusDraftRoom,
      reconcileHocuspocusDraftRoom: hocuspocusPersistence.reconcileHocuspocusDraftRoom,
      enrollHocuspocusDraftRoom: hocuspocusPersistence.enrollHocuspocusDraftRoom,
      getPersistenceQueueMetrics: hocuspocusPersistence.getPersistenceQueueMetrics,
    },
    agentEdit: {
      agentEdit: () => agentEdit,
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
      initializeEmptyDocument: runtime.markdownDocuments.initializeEmptyDocument,
      repairDocumentAuthority: runtime.markdownDocuments.repairDocumentAuthority,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      encodeSeed: runtime.markdownDocuments.encodeSeed,
      installSeed: runtime.markdownDocuments.installSeed,
      writeDocument: runtime.markdownDocuments.writeDocument,
      withLiveDocument: runtime.markdownDocuments.withLiveDocument,
      writeDocumentHeld: runtime.markdownDocuments.writeDocumentHeld,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
      bindCopiedBlocks: runtime.linkBinder.bindCopiedBlocks,
      bindStatic: runtime.linkBinder.bindStatic,
    },
    projections: {
      refreshDocumentProjection: projections.refresh,
      draftEffects: { sweep: async () => 0, flush: async () => {} },
      documentDerivations: {
        derive: async (documentId) => {
          await projections.refresh({ documentId });
          return { status: "missing" };
        },
        schedule: () => {},
        sweep: async () => 0,
        flush: async () => {},
        stop: async () => {},
      },
    },
    lineage,
    responses: responseFinalizer,
    checkpoints,
    draftAttribution: {
      async readDraftProvenance() {
        return null;
      },
    },
    attribution: {
      async getLastUpdateAttribution(documentId) {
        const latest = await store.latestUpdate(documentId);
        if (!latest) {
          return { originType: null, actorTurnId: null, actorUserId: null, updateSeq: null };
        }
        return { ...attributionFromMeta(latest.meta), updateSeq: latest.seq };
      },
    },
    draftPeers: createInMemoryDraftPeerStub(
      runtime.markdownDocuments,
      coordinator,
      runtime.model,
      runtime.codec,
      links,
    ),
    branches: createInMemoryBranchStub(),
    branchResolver: {
      branches,
      // No branches in memory: a purged Work has none to dispose of.
      workBranchDisposal: {
        withDisposal: (_workId, run) => run(async () => ({ releasedObjects: [] })),
      },
      documentPurgeDraftDisposal: {
        withDisposal: (_documentId, run) => run(async () => undefined),
      },
      // No document drafts in memory: nothing to register.
      draftLinks: { flush: async () => {} },
    },
    documentCreation,
  });
}

function createInMemoryDraftPeerStub(
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
): DraftPeerShadowAccess {
  return {
    async readEffectiveRevision(input) {
      const read = await documents.readVersionedMarkdown(input.documentId);
      return read.ok ? read.value.revision : null;
    },
    async flushDraftLivePull() {},
    readEffectiveMarkdown: (input) => documents.readVersionedMarkdown(input.documentId),
    readEffectiveBlocks: (input) =>
      coordinator.withDocument(input.documentId, async (doc) => {
        const scope = links.holder({ documentId: input.documentId, view: LIVE_VIEW });
        return Ok({
          content: [...model.projectBlocks(toDocHandle(doc))],
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
        const bound = codec.forScope(scope);
        const read = versioned(doc, scope, (doc) =>
          model.serializeBlockLines(toDocHandle(doc), bound),
        );
        const blockLinks = model
          .projectBlocks(toDocHandle(doc))
          .map((block) => spelledLinks([block], scope));
        return Ok({
          ...read,
          links: blockLinks,
          holder: { uri: scope.holder.uri, view: LIVE_VIEW },
        });
      }),
    async ensureCreatedDocumentDraft() {
      throw new Error("Branch creates need Postgres; the in-memory collab domain has no branches");
    },
    async retractCreatedDocumentDraft() {
      throw new Error("Branch creates need Postgres; the in-memory collab domain has no branches");
    },
  };
}

function createInMemoryBranchStub(): CollabBranches {
  const gone = async (input: { branchId: string }): Promise<CommandOutcome> => ({
    kind: "result",
    result: { status: "gone", branchId: input.branchId as BranchId },
  });
  return {
    draftReview: {
      async applyClick({ request }) {
        return { status: "closed", commandId: request.commandId };
      },
      async unapplyClick({ request }) {
        return { status: "closed", commandId: request.commandId };
      },
      async list() {
        return [];
      },
      async listItems() {
        return { branchId: null, items: [], threadTitles: new Map() };
      },
      async branchesChangingDocument() {
        return [];
      },
      async items() {
        return { branchId: null, items: [] };
      },
      async resolveItem() {
        return null;
      },
      async resolveItemByDocument() {
        return null;
      },
      async lookupCommand() {
        return { kind: "none" };
      },
      discardItem: (input) => gone(input.item),
      discardAll: gone,
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
