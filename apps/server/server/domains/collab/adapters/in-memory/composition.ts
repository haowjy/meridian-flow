/** Explicit in-memory collab composition and behavior-preserving unsupported stubs. */

import {
  type AgentEditCodecFactory,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { spelledLinks } from "@meridian/markup/links";
import type * as Y from "yjs";
import { Ok } from "../../../../shared/result.js";
import { createAllowAllFileAccess } from "../../../file-policy/index.js";
import { createCheckpointService } from "../../checkpoints.js";
import { createCollabFacade } from "../../collab-facade.js";
import type {
  BranchPeerShadowAccess,
  BranchPushAccess,
  CollabDomain,
  CollabDrafts,
  CommandOutcome,
} from "../../contracts.js";
import {
  attributionFromMeta,
  createAgentEditRuntime,
  metaForOrigin,
} from "../../domain/agent-edit-runtime.js";
import { createBranchCriticalSections } from "../../domain/branch-critical-sections.js";
import { createDocumentCreationAggregate } from "../../domain/document-creation.js";
import { createDocumentWriteHookRunner } from "../../domain/document-projection-refresher.js";
import { versioned } from "../../domain/document-revision.js";
import { createDrafts } from "../../domain/drafts.js";
import type { DocumentAuthorityHead } from "../../domain/ports/document-authority-heads.js";
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
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
  type InMemoryJournal,
} from "./agent-edit.js";
import { createInMemoryDraftStore, createInMemoryDraftWriteBoundary } from "./drafts.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "./static-document-link-scopes.js";

export function createInMemoryCollabDomain(): CollabDomain {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const lifecycle = createInMemoryDocumentLifecycle(coordinator);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => operation(),
    ensureDocument: lifecycle.ensureDocument,
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
    lifecycle: documentCreation,
    initialDocumentSeeds: {
      async seedInitialDocument(documentId, state) {
        const snapshot = await journal.read(documentId);
        if (snapshot.checkpoint || snapshot.updates.length > 0) return false;
        await journal.seedInitialDocument(documentId, state);
        return true;
      },
    },
    runDocumentWriteHook,
    resolveDocumentFiletype: async () => null,
    observability: createAgentEditObservabilityOptions({}),
  });
  const drafts = createDrafts({
    store: createInMemoryDraftStore(),
    boundary: createInMemoryDraftWriteBoundary(),
  });
  // No Work drafts exist in memory, so the pool routes both destinations to the live core.
  const fileAccess = createAllowAllFileAccess();
  const agentEdit = createThreadPeerCorePool({
    drafts,
    branches: { getBranch: async () => null },
    liveUtilityCore: runtime.liveUtilityCore,
    createThreadCore: () => runtime.liveUtilityCore,
    pullThreadPeer: async () => undefined,
    // Thread cores are the live core here, so nothing is ever pinned to a branch.
    fences: createReplySaveFences({
      liveUtilityCore: runtime.liveUtilityCore,
      branches: { getBranch: async () => null },
      criticalSections: createBranchCriticalSections(),
      drafts,
      fileAccess,
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
    }),
    commitThreadResponseAtomically: (operation) => operation(),
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
  const authorityHeads = createInMemoryAuthorityHeads(journal);
  const lineage = createTurnLiveLineageReadModel({
    store: createInMemoryTurnLiveLineageStore(journal),
    resolveDocumentUri: async (documentId) => documentId,
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
    lifecycle: { dispose: () => {} },
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      primeReservedNamespaceIndex,
      headSchemaVersion: async () => null,
      resolveBranchHocuspocusRoom: hocuspocusPersistence.resolveBranchHocuspocusRoom,
      loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,
      loadHocuspocusBranchState: hocuspocusPersistence.loadHocuspocusBranchState,
      admitLiveWriterUpdate: hocuspocusPersistence.admitLiveWriterUpdate,
      currentLiveGeneration: hocuspocusPersistence.currentLiveGeneration,
      validateHocuspocusDocument: hocuspocusPersistence.validateHocuspocusDocument,
      admitBranchWriterUpdate: hocuspocusPersistence.admitBranchWriterUpdate,
      writerIngressBarrier: hocuspocusPersistence.writerIngressBarrier,
      persistConnectionUpdate: hocuspocusPersistence.persistConnectionUpdate,
      storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,
      storeHocuspocusBranch: hocuspocusPersistence.storeHocuspocusBranch,
      drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,
      drainHocuspocusBranchPersistence: hocuspocusPersistence.drainHocuspocusBranchPersistence,
      closeHocuspocusBranchRoom: hocuspocusPersistence.closeHocuspocusBranchRoom,
      rejectStaleBranchSyncStep1: hocuspocusPersistence.rejectStaleBranchSyncStep1,
      getPersistenceQueueMetrics: hocuspocusPersistence.getPersistenceQueueMetrics,
    },
    authorityHeads,
    agentEdit: {
      agentEdit: () => agentEdit,
    },
    reversal: {
      reverseTurn: async () => {
        throw new Error("Turn receipts require the durable Postgres receipt adapter");
      },
      reverseThreadContext: UNSUPPORTED_REVERSE_THREAD_CONTEXT,
    },
    documents: {
      ensureDocument: lifecycle.ensureDocument,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      writeDocument: runtime.markdownDocuments.writeDocument,
      withLiveDocument: runtime.markdownDocuments.withLiveDocument,
      writeDocumentHeld: runtime.markdownDocuments.writeDocumentHeld,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
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
        flush: async () => {},
        stop: async () => {},
      },
    },
    lineage,
    responses: responseFinalizer,
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
    branchPush: IN_MEMORY_BRANCH_PUSH_STUB,
    branchPeers: createInMemoryBranchPeerStub(
      runtime.markdownDocuments,
      coordinator,
      runtime.model,
      runtime.codec,
      links,
    ),
    drafts: createInMemoryDraftStub(),
    draftResolver: {
      drafts,
      // No draft branches in memory: a whole draft leases nothing.
      draftLeases: {
        withDraftBranches: (_draftId, run) =>
          createBranchCriticalSections().withBranches([], (lease) => run(lease, [])),
      },
      // No drafts in memory: a purged Work has none to dispose of.
      workDraftDisposal: {
        withDisposal: (_workId, run) => run(async () => ({ releasedObjects: [] })),
      },
      // No draft branches in memory: nothing to register.
      draftLinks: { flush: async () => {} },
    },
    documentCreation,
  });
}

const IN_MEMORY_BRANCH_PUSH_STUB: BranchPushAccess = {
  async recoverPendingLiveSettlements() {
    return 0;
  },
  async countPendingByWorkIds() {
    return new Map();
  },
  async setWorkPushPolicy() {
    throw new Error("Branch push service is not configured");
  },
};

function createInMemoryBranchPeerStub(
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
): BranchPeerShadowAccess {
  return {
    async readEffectiveRevision(input) {
      const read = await documents.readVersionedMarkdown(input.documentId);
      return read.ok ? read.value.revision : null;
    },
    async flushBranchLivePull() {},
    readEffectiveMarkdown: (input) => documents.readVersionedMarkdown(input.documentId),
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
    async ensureCreatedDraftBranch() {
      throw new Error("Draft creates need Postgres; the in-memory collab domain has no drafts");
    },
    async retractCreatedDraftBranch() {
      throw new Error("Draft creates need Postgres; the in-memory collab domain has no drafts");
    },
  };
}

function createInMemoryDraftStub(): CollabDrafts {
  const gone = async (input: { draftId: string }): Promise<CommandOutcome> => ({
    kind: "result",
    result: { status: "gone", draftId: input.draftId as DraftId },
  });
  return {
    draftReview: {
      async list() {
        return [];
      },
      async listItems() {
        return { draftId: null, items: [], threadTitles: new Map() };
      },
      async items() {
        return { draftId: null, items: [] };
      },
      async resolveItem() {
        return null;
      },
      async resolveItemByDocument() {
        return null;
      },
      async preview(input) {
        return { status: "gone", itemKey: input.itemKey };
      },
      async lookupCommand() {
        return { kind: "none" };
      },
      applyItem: (input) => gone(input.item),
      applyAll: gone,
      applyChanges: async (input) => ({
        kind: "result",
        result: {
          status: "gone",
          draftId: input.envelope.draftId as DraftId,
          itemKey: input.itemKey,
        },
      }),
      discardItem: (input) => gone(input.item),
      discardChanges: async (input) => ({
        kind: "result",
        result: {
          status: "gone",
          draftId: input.envelope.draftId as DraftId,
          itemKey: input.itemKey,
        },
      }),
      discardAll: gone,
    },
  };
}

function createInMemoryAuthorityHeads(journal: InMemoryJournal) {
  const heads = new Map<string, DocumentAuthorityHead>();
  return {
    async ensureAndReadAuthorityHeads(documentIds: DocumentId[]) {
      return Promise.all(
        [...new Set(documentIds)].sort().map(async (documentId) => {
          let head = heads.get(documentId);
          if (!head) {
            head = {
              documentId,
              authorityId: crypto.randomUUID() as DocumentAuthorityHead["authorityId"],
              generation: 1n,
              admittedThrough: 0n,
            };
            heads.set(documentId, head);
          }
          return { ...head, admittedThrough: BigInt(await journal.latestUpdateSeq(documentId)) };
        }),
      );
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
