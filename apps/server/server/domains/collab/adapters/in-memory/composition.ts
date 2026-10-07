/** Explicit in-memory collab composition and behavior-preserving unsupported stubs. */

import {
  type AgentEditCodec,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
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
} from "../../contracts.js";
import {
  attributionFromMeta,
  createAgentEditRuntime,
  metaForOrigin,
} from "../../domain/agent-edit-runtime.js";
import { BranchNotFoundError } from "../../domain/branch-resolver.js";
import { createDocumentCreationAggregate } from "../../domain/document-creation.js";
import { createDocumentWriteHookRunner } from "../../domain/document-projection-refresher.js";
import { versioned } from "../../domain/document-revision.js";
import type { DocumentAuthorityHead } from "../../domain/ports/document-authority-heads.js";
import { primeReservedNamespaceIndex } from "../../domain/provenance.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "../../domain/response-transaction.js";
import { createResponseWriteFinalizer } from "../../domain/response-write-finalizer.js";
import { createThreadPeerCorePool } from "../../domain/thread-peer-core-pool.js";
import { createTurnLiveLineageReadModel } from "../../domain/turn-live-lineage.js";
import { reverseTurn } from "../../domain/turn-reversal.js";
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
  const runtime = createAgentEditRuntime({
    journal,
    coordinator,
    lifecycle: documentCreation,
    initialDocumentSeeds: {
      async seedInitialDocument(documentId, state) {
        const snapshot = await journal.read(documentId);
        if (snapshot.checkpoint || snapshot.updates.length > 0) return false;
        await journal.checkpoint(documentId, state, 0);
        return true;
      },
    },
    runDocumentWriteHook,
    resolveDocumentFiletype: async () => null,
    observability: createAgentEditObservabilityOptions({}),
  });
  // No Work drafts exist in memory, so the pool routes both destinations to the live core.
  const agentEdit = createThreadPeerCorePool({
    liveUtilityCore: runtime.liveUtilityCore,
    createThreadCore: () => runtime.liveUtilityCore,
    liveHistory: journal,
    reversalHistory: {
      branches: {
        resolveThreadBranch: async (documentId, threadId) => {
          throw new BranchNotFoundError(documentId, threadId);
        },
        getBranch: async () => null,
      },
      branchRows: { listJournalRowsForBranch: async () => [] },
    },
    discardThreadPeerBranches: async () => {},
    pullThreadPeer: async () => undefined,
    commitThreadResponseAtomically: (operation) => operation(),
    responseTransactionSettlement: {
      deferUntilCommit: () => false,
      deferUntilRollback: () => false,
    },
    responseTransactions: { enlist: enlistResponseParticipant, run: runResponseTransaction },
    fileAccess: createAllowAllFileAccess(),
    lockWorks: async () => {},
    lockLiveDocuments: async () => {},
  });
  const projections = { refresh: runDocumentWriteHook };
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal,
    hocuspocus: hocuspocusBinding.current,
    metaForOrigin,
    latestUpdateSeq: store.latestUpdateSeq,
    emitAgentEditInvariantViolation() {},
  });
  const authorityHeads = createInMemoryAuthorityHeads(journal);
  const lineage = createTurnLiveLineageReadModel({
    store: createInMemoryTurnLiveLineageStore(journal),
    resolveDocumentUri: async (documentId) => documentId,
  });
  const responseFinalizer = createResponseWriteFinalizer({
    agentEdit,
    liveAgentEdit: runtime.liveUtilityCore,
    reversalStore: journal,
    liveReversal: {
      checkDependentLaterLiveRows: async () => ({
        hasDependents: false,
        blockingActorTypes: [],
        checkedUntilSeq: 0,
      }),
    },
    resolveDocumentUri: async (documentId) => documentId,
    branches: {
      async checkpointThreadPeer() {},
      async prepareFailedResponseRollback() {
        return async () => {};
      },
    },
    projections,
    notices: SILENT_POST_DURABILITY_NOTICES,
  });
  const checkpoints = createCheckpointService({
    coordinator,
    store,
    latestUpdateSeq: store.latestUpdateSeq,
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
      reverseTurn: (input) =>
        reverseTurn(
          {
            reversalStore: journal,
            agentEdit: runtime.liveUtilityCore,
            resolveDocumentUri: async (documentId) => documentId,
            checkDependentLaterLiveRows: async () => ({
              hasDependents: false,
              blockingActorTypes: [],
              checkedUntilSeq: 0,
            }),
            refreshDocumentProjection: projections.refresh,
          },
          input,
        ),
      reverseThreadContext: UNSUPPORTED_REVERSE_THREAD_CONTEXT,
    },
    documents: {
      ensureDocument: lifecycle.ensureDocument,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      writeDocument: runtime.markdownDocuments.writeDocument,
      editDocument: runtime.markdownDocuments.editDocument,
    },
    projections: {
      refreshDocumentProjection: projections.refresh,
      rewriteDocumentLinks: async () => {
        throw new Error("Link maintenance requires durable transactions");
      },
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
    ),
    drafts: createInMemoryDraftStub(runtime.markdownDocuments),
    documentCreation,
  });
}

const IN_MEMORY_BRANCH_PUSH_STUB: BranchPushAccess = {
  async recoverPendingLiveSettlements() {
    return 0;
  },
  async pushToLive() {
    throw new Error("Branch push service is not configured");
  },
  async countPendingByWorkIds() {
    return new Map();
  },
  async setWorkPushPolicy() {
    throw new Error("Branch push service is not configured");
  },
  async markFailedResponseRollbackPending() {
    throw new Error("Branch review service is not configured");
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
  codec: AgentEditCodec,
): BranchPeerShadowAccess {
  return {
    async readEffectiveRevision(input) {
      const read = await documents.readVersionedMarkdown(input.documentId);
      return read.ok ? read.value.revision : null;
    },
    async pullThreadPeer() {},
    async flushBranchLivePull() {},
    readEffectiveMarkdown: (input) => documents.readVersionedMarkdown(input.documentId),
    readEffectiveHashlines: (input) =>
      coordinator.withDocument(input.documentId, async (doc) =>
        Ok(versioned(doc, (doc) => model.serializeBlockLines(toDocHandle(doc), codec))),
      ),
    async resolveManifestMembership() {
      return { documentId: "" as DocumentId, members: [] };
    },
    async reconcileProjectManifest() {},
    async recordManifestDocumentCreated() {},
    async recordManifestDocumentDeleted() {},
  };
}

function createInMemoryDraftStub(documents: {
  readAsMarkdown(
    documentId: string,
  ): ReturnType<
    import("../../domain/markdown-document.js").MarkdownDocumentEngine["readAsMarkdown"]
  >;
}): CollabDrafts {
  return {
    draftReview: {
      async list() {
        return [];
      },
      async preview(input) {
        const live = await documents.readAsMarkdown(input.documentId);
        if (!live.ok) throw new Error(`read_failed:${live.error.code}`);
        return { status: "gone", draftId: input.draftId, live: live.value };
      },
      async applyWorkDraft(input) {
        return {
          status: "not_found",
          draftId: input.draftId,
        };
      },
      async applyWorkDraftChanges(input) {
        return { status: "gone", draftId: input.draftId };
      },
      async discardWorkDraft(input) {
        return {
          status: "discarded",
          draftId: input.draftId,
        };
      },
    },
    draftSessionStats: {
      async listActiveDraftsByWork() {
        return [];
      },
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
    createCheckpoint: (docId: string, state: Uint8Array, reason: string, upToSeq: number) =>
      journal.createCheckpoint(docId, state, reason, upToSeq),
    getCheckpoint: (id: string) => journal.getCheckpoint(id),
    listCheckpoints: (docId: string) => journal.listCheckpoints(docId),
    latestUpdate: (docId: string) => journal.latestUpdate(docId),
    latestUpdateSeq: (docId: string) => journal.latestUpdateSeq(docId),
  };
}
