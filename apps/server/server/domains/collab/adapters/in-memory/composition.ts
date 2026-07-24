/** Explicit in-memory collab composition and behavior-preserving unsupported stubs. */
import {
  type AgentEditCodec,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import { Ok } from "../../../../shared/result.js";
import { createCheckpointService } from "../../checkpoints.js";
import { createCollabFacade } from "../../collab-facade.js";
import type {
  BranchPeerShadowAccess,
  BranchPushAccess,
  CollabDomain,
  CollabDrafts,
} from "../../contracts.js";
import { asThreadPeerAgentEditCore } from "../../domain/agent-edit-cores.js";
import {
  attributionFromMeta,
  createAgentEditRuntime,
  metaForOrigin,
} from "../../domain/agent-edit-runtime.js";
import {
  createDocumentProjectionRefresher,
  createDocumentWriteHookRunner,
} from "../../domain/document-projection-refresher.js";
import type { DocumentAuthorityHead } from "../../domain/ports/document-authority-heads.js";
import { createResponseWriteFinalizer } from "../../domain/response-write-finalizer.js";
import { createTurnLiveLineageReadModel } from "../../domain/turn-live-lineage.js";
import { reverseTurn } from "../../domain/turn-reversal.js";
import { createHocuspocusPersistenceService } from "../../hocuspocus-persistence.js";
import { createAgentEditObservabilityOptions } from "../agent-edit-observability.js";
import { SILENT_POST_DURABILITY_NOTICES } from "../declared-stubs.js";
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
  const hocuspocusBinding = createHocuspocusBinding();
  const store = inMemoryStore(journal);
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: async () => {},
  });
  const runtime = createAgentEditRuntime({
    journal,
    coordinator,
    lifecycle,
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
  const agentEdit = asThreadPeerAgentEditCore(runtime.liveUtilityCore);
  const projections = createDocumentProjectionRefresher({
    documents: runtime.markdownDocuments,
    runDocumentWriteHook,
  });
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
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      resolveBranchHocuspocusRoom: hocuspocusPersistence.resolveBranchHocuspocusRoom,
      loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,
      loadHocuspocusBranchState: hocuspocusPersistence.loadHocuspocusBranchState,
      admitLiveWriterUpdate: hocuspocusPersistence.admitLiveWriterUpdate,
      currentLiveGeneration: hocuspocusPersistence.currentLiveGeneration,
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
    agentEdit: { agentEdit: () => agentEdit },
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
    },
    documents: {
      ensureDocument: lifecycle.ensureDocument,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      writeDocument: runtime.markdownDocuments.writeDocument,
      editDocument: runtime.markdownDocuments.editDocument,
    },
    projections: { refreshDocumentProjection: projections.refresh },
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
    trailForwardActions: {
      async applyTrailForwardAction() {
        return { status: "anchor_unavailable" };
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
  });
}

const IN_MEMORY_BRANCH_PUSH_STUB: BranchPushAccess = {
  async recoverPendingLiveSettlements() {
    return 0;
  },
  async pushToLive() {
    throw new Error("Branch push service is not configured");
  },
  async pushSelectedToLive() {
    throw new Error("Branch push service is not configured");
  },
  async countUnpushedRowsForWork() {
    return 0;
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
    readAsMarkdown(
      documentId: string,
    ): ReturnType<
      import("../../domain/markdown-document.js").MarkdownDocumentEngine["readAsMarkdown"]
    >;
  },
  coordinator: {
    withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
  },
  model: YProsemirrorDocumentModel,
  codec: AgentEditCodec,
): BranchPeerShadowAccess {
  return {
    async pullThreadPeer() {},
    async flushBranchLivePull() {},
    readEffectiveMarkdown: (input) => documents.readAsMarkdown(input.documentId),
    readEffectiveHashlines: (input) =>
      coordinator.withDocument(input.documentId, async (doc) =>
        Ok(model.serializeBlockLines(toDocHandle(doc), codec)),
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
        return { status: "gone", live: live.value };
      },
      async accept(input) {
        return {
          status: "not_found",
          draftId: input.draftId ?? input.branchId ?? "",
        };
      },
      async reject(input) {
        return {
          status: "discarded",
          draftId: input.draftId ?? input.branchId ?? "",
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
