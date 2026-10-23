/** Production dependency graph for the server collab domain. */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { lockDocumentMutation } from "../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  deferUntilDrizzleRollback,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} from "../../shared/drizzle-transaction.js";
import {
  createDocumentLastAddress,
  createDocumentUriResolver,
} from "../context/document-uri-resolver.js";
import type { ContextCatalogMutationPort } from "../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../context/ports/document-removal.js";
import { createRemovalRecords, readRemovalRecords } from "../context/tree/removal.js";
import { createTreeReader } from "../context/tree/tree-view.js";
import type { FileAccess } from "../file-policy/index.js";
import type { NoticePort } from "../notices/index.js";
import { type EventSink, emitEvent } from "../observability/index.js";
import type { WorkProjectionMutation } from "../projects/index.js";
import type { ObjectRelease } from "../storage/index.js";
import {
  createAgentEditInvariantDiagnostic,
  createAgentEditObservabilityOptions,
  createAppendCommittedEvent,
  createDocumentProjectionDiagnostics,
  createDraftAgentEditDiagnostics,
  createDraftAheadDiagnostics,
  createDraftProjectionDiagnostics,
  createDraftPullDiagnostics,
  createMarkdownSerializationAnomalyObserver,
  createResponseTransactionDiagnostics,
  createReversalNoticeDiagnostics,
  createRewriteCommittedEvent,
  createRoomDeliveryDiagnostics,
  createWriterFrameDiagnostics,
} from "./adapters/agent-edit-observability.js";
import {
  SILENT_POST_DURABILITY_NOTICES,
  SILENT_TURN_INVERSE_NOTICES,
  UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
} from "./adapters/declared-stubs.js";
import { createDrizzleApplyClick, measureApplyAppend } from "./adapters/drizzle-apply-click.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import { createDrizzleBranchCommands } from "./adapters/drizzle-branch-commands.js";
import {
  createDrizzleBranchDiscard,
  createDrizzleWorkBranchDisposal,
} from "./adapters/drizzle-branch-discard.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleCollabLookups } from "./adapters/drizzle-collab-lookups.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import { createDrizzleAuthorityGenerationReader } from "./adapters/drizzle-document-authority-head.js";
import {
  type AheadRegistrationRecovery,
  createDrizzleDocumentDerivationStore,
} from "./adapters/drizzle-document-derivations.js";
import type { DraftClose } from "./adapters/drizzle-draft-close.js";
import { createDrizzleDraftDispositionStore } from "./adapters/drizzle-draft-disposition.js";
import { createDrizzleDraftReplayJournalReads } from "./adapters/drizzle-draft-journal-reads.js";
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createDrizzleTreeHistory } from "./adapters/drizzle-tree-history.js";
import { createDrizzleTurnInverseService } from "./adapters/drizzle-turn-inverse.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import { createHocuspocusBinding } from "./adapters/hocuspocus-binding.js";
import {
  createDeferredLiveProjectionCoordinator,
  createHocuspocusCoordinator,
} from "./adapters/hocuspocus-coordinator.js";
import { createCheckpointService } from "./checkpoints.js";
import { createCollabFacade } from "./collab-facade.js";
import type { CollabDomain } from "./contracts.js";
import { createAgentEditRuntime, metaForOrigin } from "./domain/agent-edit-runtime.js";
import { createApplyClickService } from "./domain/apply-click.js";
import { createBranchDiscard } from "./domain/branch-discard.js";
import { createBranchReviewIdentity } from "./domain/branch-review-identity.js";
import { createBranchReviewItems } from "./domain/branch-review-items.js";
import { createBranches } from "./domain/branches.js";
import { createDocumentAttribution } from "./domain/document-attribution.js";
import { createDocumentCreationAggregate } from "./domain/document-creation.js";
import { createDocumentDerivationService } from "./domain/document-derivations.js";
import {
  scopeAgentEdit,
  scopeDraftPeer,
  scopeResponseFinalizer,
} from "./domain/document-link-scope-doors.js";
import {
  createDocumentWriteHookRunner,
  createProjectionEffectsDocumentWriteHook,
} from "./domain/document-projection-refresher.js";
import { createDraftAheadRegistration } from "./domain/draft-ahead-registration.js";
import type { AttemptScope } from "./domain/draft-attempts.js";
import { createDraftCoordinator } from "./domain/draft-coordinator.js";
import { createDraftProjection } from "./domain/draft-projection.js";
import { createDraftProvenanceReader } from "./domain/draft-provenance.js";
import { createDraftPullService } from "./domain/draft-pulls.js";
import { createDraftRetirement } from "./domain/draft-retirement.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import { createModelDocumentEdits } from "./domain/model-document-edits.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import { primeReservedNamespaceIndex } from "./domain/provenance.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "./domain/response-transaction.js";
import { createResponseWriteFinalizer } from "./domain/response-write-finalizer.js";
import {
  createPostDurabilityNoticeService,
  createReversalNoticePort,
} from "./domain/reversal-notices.js";
import { createTurnLiveLineageReadModel } from "./domain/turn-live-lineage.js";
import {
  createTurnReversalService,
  type ThreadContextReversalResolver,
} from "./domain/turn-reversal-service.js";
import { createWorkBranchReviewService } from "./domain/work-branch-review-service.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import { closeRemovedDocumentRooms } from "./hocuspocus-rooms.js";
import { createDraftThreadPeerAgentEditCore } from "./thread-peer-composition.js";

export type { DocumentWriteHook } from "./contracts.js";

import type { DetachedWorkTracker } from "../runtime/detached-work.js";

type CollabDomainDeps = {
  backgroundTasks?: DetachedWorkTracker;
  db: Database;
  /** How links and image sources spell, loaded per document operation (contract §4.4). */
  links: DocumentLinkScopes;
  /** Durable registration of ahead refs the model's writes mint. */
  aheadRefs: AheadRefRegistrar;
  threadContext?: ThreadContextReversalResolver;
  eventSink?: EventSink;
  notices?: NoticePort;
  workProjectionMutation: WorkProjectionMutation;
  /**
   * Confirms writes' grants under lock where they become durable (file-access
   * §5); the writer's turn undo also asks it for its grants.
   */
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  /** How long a live AI write waits before merging into Work drafts; tests shorten it. */
  livePullDebounceMs?: number;
  /** Ahead-ref settlement at tracked creates and Apply completions (contract §9.3–9.4). */
  arrivals?: DocumentArrivals;
  /** Catalog reconciliation inside Apply's completion, warm or recovered (F23). */
  catalogMutations: ContextCatalogMutationPort;
  /** Registers client-minted ahead refs after certified derives, and recovers failures (§11.3). */
  aheadRegistrations?: AheadRegistrationRecovery;
  /** Deletes a discarded hidden image's stored object after commit (§12.2 step 4). */
  objects?: Pick<ObjectRelease, "storageUrls">;
  /** The one draft close; this domain binds its retirement once its rooms and cores exist. */
  draftClose: DraftClose;
  /** The tree's removal kernel, built at the composition root over `draftClose`. */
  documentRemoval: DocumentRemoval;
};

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const persistence = createDrizzleCollabPersistence(deps.db);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => runInDrizzleTransaction(deps.db, operation),
    onArrival: (id) => deps.arrivals?.settle([id]) ?? Promise.resolve(0),
  });
  const hocuspocusBinding = createHocuspocusBinding(deps.eventSink);
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: hocuspocusBinding.require,
    journal: persistence.journal,
    transactions: { inTransaction: isInDrizzleTransaction, afterCommit: deferUntilDrizzleCommit },
    diagnostics: createRoomDeliveryDiagnostics(deps.eventSink),
  });
  // Every bounded draft-store attempt's rollback boundary (decision D13).
  const attemptScope: AttemptScope = (operation) => runInDrizzleSavepoint(deps.db, operation);
  // Removal records for the reply save that answers with them.
  const removalRecords = createRemovalRecords(deps.db);
  const workBranches = createBranches({
    store: createDrizzleBranchStore(deps.db),
    boundary: createDrizzleBranchWriteBoundary(deps.db, deps.workProjectionMutation),
  });
  const drafts = createDrizzleDraftStore(deps.db, {
    close: deps.draftClose,
    live: {
      journal: persistence.journal,
    },
    workProjection: deps.workProjectionMutation,
    branches: workBranches,
    ...(deps.eventSink
      ? {
          onRewriteCommitted: createRewriteCommittedEvent(deps.eventSink),
          onAppendSequenced: (detail) => {
            if (deps.eventSink) createAppendCommittedEvent(deps.eventSink)(detail);
            measureApplyAppend(detail);
          },
        }
      : {}),
  });
  const writerFrameDiagnostics = createWriterFrameDiagnostics(deps.eventSink);
  const replayJournal = createDrizzleDraftReplayJournalReads(deps.db);
  const draftCoordinator = createDraftCoordinator({
    store: drafts,
    attemptScope,
    onDraftUpdate: hocuspocusBinding.deliverDraftUpdate,
    applyToRoom: hocuspocusBinding.applyToRoom,
    diagnostics: writerFrameDiagnostics,
    // The projection is composed below, over the coordinator; a mark only fires after a commit.
    onAppendCommitted: (draftId) => draftEffects.markDirty(draftId),
  });
  const draftPulls = createDraftPullService({
    // A pull isn't the write that scheduled it: it leaves that write's grants too.
    outsideTransaction: runOutsideWrite,
    liveJournal: persistence.journal,
    draftCoordinator,
    drafts,
    diagnostics: createDraftPullDiagnostics(deps.eventSink),
    ...(deps.livePullDebounceMs === undefined ? {} : { debounceMs: deps.livePullDebounceMs }),
  });
  const draftEffects = createDraftProjection({
    coordinator: draftCoordinator,
    store: drafts,
    diagnostics: createDraftProjectionDiagnostics(deps.eventSink),
    outsideTransaction: runOutsideWrite,
  });

  const documentUriResolver = createDocumentUriResolver(deps.db);
  const documentLastAddress = createDocumentLastAddress(deps.db);
  const lookups = createDrizzleCollabLookups(deps.db);
  const projectionEffects = createDrizzleDocumentProjectionEffects(
    deps.db,
    deps.workProjectionMutation,
  );
  const projectionDiagnostics = createDocumentProjectionDiagnostics(deps.eventSink);
  const noticeDiagnostics = createReversalNoticeDiagnostics(deps.eventSink);
  const derivationStore = createDrizzleDocumentDerivationStore(
    deps.db,
    documentLastAddress,
    deps.aheadRegistrations
      ? {
          registry: deps.aheadRegistrations,
          ...(deps.eventSink ? { eventSink: deps.eventSink } : {}),
        }
      : undefined,
  );
  const derivations = createDocumentDerivationService({
    store: derivationStore,
    serializer: {
      serializeDocument: (...args) => runtime.markdownDocuments.serializeDocument(...args),
    },
    outsideTransaction: runOutsideDrizzleTransaction,
    deferred: (documentId) => {
      if (!deps.eventSink) return;
      emitEvent(deps.eventSink, {
        level: "debug",
        source: "collab.document_derivation",
        name: "projection_refresh.deferred",
        correlation: { documentId },
        payload: { reason: "stale_cut" },
      });
    },
    failed: (documentId, cause) =>
      projectionDiagnostics.failed({
        documentId,
        source: "collab.document_derivation",
        name: "projection_refresh.failed",
        payload: projectionDiagnostics.payload(cause),
      }),
  });
  const documentWriteHook = createProjectionEffectsDocumentWriteHook(
    projectionEffects,
    derivations.derive,
  );
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: documentWriteHook,
    diagnostics: projectionDiagnostics,
  });
  const observability = createAgentEditObservabilityOptions({
    eventSink: deps.eventSink,
  });
  const modelDocumentEdits = createModelDocumentEdits({
    service: () => turnInverse,
    drafts,
    coordinator: liveCoordinator,
  });
  const responseTransactionDiagnostics = createResponseTransactionDiagnostics(deps.eventSink);
  const runtime = createAgentEditRuntime({
    documentEdits: modelDocumentEdits,
    journal: persistence.journal,
    coordinator: liveCoordinator,
    agentCoordinator: createDeferredLiveProjectionCoordinator({
      hocuspocus: hocuspocusBinding.require,
      journal: persistence.journal,
      live: liveCoordinator,
      transactions: {
        inTransaction: isInDrizzleTransaction,
        outsideTransaction: runOutsideDrizzleTransaction,
        afterCommit: deferUntilDrizzleCommit,
      },
    }),
    initialDocumentSeeds: persistence.seeds,
    deferUntilCommit: deferUntilDrizzleCommit,
    runDocumentWriteHook,
    resolveDocumentFiletype: lookups.resolveDocumentFiletype,
    observability,
    links: deps.links,
    aheadRefs: deps.aheadRefs,
    inTransaction: isInDrizzleTransaction,
    observeSerializationAnomaly: createMarkdownSerializationAnomalyObserver(deps.eventSink),
  });
  const projectionRefresher = { refresh: runDocumentWriteHook };

  const workBranchPendingStore = createDrizzleWorkBranchPendingStore(deps.db);
  const agentEdit = scopeAgentEdit(
    createDraftThreadPeerAgentEditCore({
      documentEdits: modelDocumentEdits,
      branches: workBranches,
      liveUtilityCore: runtime.liveUtilityCore,
      fileAccess: deps.fileAccess,
      removals: removalRecords,
      async lockWorks(workIds) {
        await deps.workProjectionMutation.lockWorks({ works: workIds as WorkId[] });
      },
      async lockLiveDocuments(documentIds) {
        const tx = currentDrizzleDb(deps.db);
        for (const documentId of documentIds) await lockDocumentMutation(tx, documentId);
      },
      journal: persistence.journal,
      drafts,
      draftCoordinator,
      draftPulls,
      draftJournal: replayJournal,
      diagnostics: createDraftAgentEditDiagnostics(deps.eventSink),
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      aheadRefs: deps.aheadRefs,
      semanticProvenance: runtime.semanticProvenance,
      observability,
      commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(deps.db, operation),
      attemptScope,
      responseTransactionSettlement: {
        deferUntilCommit: deferUntilDrizzleCommit,
        deferUntilRollback: deferUntilDrizzleRollback,
      },
      responseTransactions: {
        enlist: enlistResponseParticipant,
        run: (atomic, operation, settlement) =>
          runResponseTransaction(atomic, operation, settlement, responseTransactionDiagnostics),
      },
    }),
    deps.links,
  );

  const draftAheads = createDraftAheadRegistration({
    drafts: draftCoordinator,
    branches: workBranches,
    registrar: deps.aheadRefs,
    outsideTransaction: runOutsideDrizzleTransaction,
    diagnostics: createDraftAheadDiagnostics(deps.eventSink),
    // The writer's own links follow the pull cadence: soon after typing, never per keystroke.
    ...(deps.livePullDebounceMs === undefined ? {} : { debounceMs: deps.livePullDebounceMs }),
  });
  const authorityGeneration = createDrizzleAuthorityGenerationReader(deps.db);
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    backgroundTasks: deps.backgroundTasks,
    journal: persistence.journal,
    draftStore: drafts,
    draftCoordinator,
    hocuspocus: hocuspocusBinding.current,
    eventSink: deps.eventSink,
    metaForOrigin,
    afterCallerCommit: (callback) => {
      runAfterDrizzleCommit(callback);
    },
    readAuthorityHeadGeneration: authorityGeneration,
    emitAgentEditInvariantViolation: createAgentEditInvariantDiagnostic(deps.eventSink),
    onLiveUpdatePersisted: (documentId) => {
      draftPulls.scheduleLivePull(documentId);
      derivations.schedule(documentId);
    },
    onDraftWriterUpdateAdmitted: (draftId) => draftAheads.schedule(draftId),
  });

  const postDurabilityNotices = deps.notices
    ? createPostDurabilityNoticeService({
        notices: deps.notices,
        documentUriResolver,
        diagnostics: noticeDiagnostics,
      })
    : SILENT_POST_DURABILITY_NOTICES;
  const treeHistory = createDrizzleTreeHistory(deps.db, persistence.journal);
  const turnInverse = createDrizzleTurnInverseService({
    onDraftCommitted: (draftId) => draftEffects.markDirty(draftId),
    db: deps.db,
    journal: persistence.journal,
    drafts,
    coordinator: liveCoordinator,
    draftCoordinator,
    resolveDocumentUri: documentUriResolver,
    refreshDocument: (documentId) => projectionRefresher.refresh({ documentId }),
    flushLivePull: draftPulls.flushLivePull,
    notices: deps.notices
      ? createReversalNoticePort({
          notices: deps.notices,
          documentUriResolver,
          diagnostics: noticeDiagnostics,
        })
      : SILENT_TURN_INVERSE_NOTICES,
    workProjection: deps.workProjectionMutation,
    removal: deps.documentRemoval,
    arrivals: deps.arrivals,
    catalog: deps.catalogMutations,
    fileAccess: deps.fileAccess,
  });
  const responseFinalizer = scopeResponseFinalizer(
    createResponseWriteFinalizer({
      agentEdit,
      rollback: turnInverse,
      projections: projectionRefresher,
      notices: postDurabilityNotices,
    }),
    deps.links,
  );
  const reviewItems = createBranchReviewItems({
    tree: createTreeReader(deps.db),
    drafts: (branchId, documentIds) =>
      workBranchPendingStore.listBranchDraftMetadata(branchId, documentIds),
    pendingThreadIds: workBranchPendingStore.pendingThreadIds,
    treeActors: (branchId, documentIds) =>
      workBranchPendingStore.listTreeActors(branchId, documentIds),
  });
  // Exactly what each committed transaction ended: its closed drafts' rooms and thread peers.
  deps.draftClose.bindRetirement(
    createDraftRetirement({
      closeDraftRoom: hocuspocusPersistence.closeHocuspocusDraftRoom,
      closeRemovedRooms: (documentIds, draftIds) =>
        closeRemovedDocumentRooms(
          hocuspocusBinding.current(),
          documentIds,
          draftIds,
          removalRecords.lookup,
        ),
      agentEdit,
    }),
    (error) => {
      if (deps.eventSink)
        emitEvent(deps.eventSink, {
          level: "error",
          source: "collab.retirement",
          name: "after_commit.failed",
          payload: { error: String(error) },
        });
    },
  );
  const discardStore = createDrizzleBranchDiscard(deps.db, {
    removal: deps.documentRemoval,
    close: deps.draftClose,
    branches: workBranches,
    workProjection: deps.workProjectionMutation,
    catalog: deps.catalogMutations,
  });
  const discard = createBranchDiscard({
    branches: workBranches,
    store: discardStore,
    holdRetirement: deps.draftClose.holdRetirement,
    releaseObjects: (storageUrls) => deps.objects?.storageUrls(storageUrls) ?? Promise.resolve(),
    attemptScope,
  });
  const identity = createBranchReviewIdentity({ branches: workBranches, reviewItems });
  const commands = createDrizzleBranchCommands(deps.db);
  const applyClick = createApplyClickService({
    identity,
    commands,
    evidence: createDrizzleDraftDispositionStore(deps.db),
    store: createDrizzleApplyClick(deps.db, {
      workProjection: deps.workProjectionMutation,
      branches: workBranches,
      coordinator: draftCoordinator,
      live: persistence.journal,
      liveCoordinator,
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      trail: createDrizzleChangeTrailAggregateWriter(deps.db),
      arrivals: deps.arrivals,
      catalog: deps.catalogMutations,
      removal: deps.documentRemoval,
      close: deps.draftClose,
      releaseObjects: (storageUrls) => deps.objects?.storageUrls(storageUrls) ?? Promise.resolve(),
      onCommitted: async (documentId) => {
        await draftPulls.flushLivePull(documentId);
        await runDocumentWriteHook({ documentId }, "collab.apply");
      },
      measured: (measurement) => {
        if (deps.eventSink)
          emitEvent(deps.eventSink, {
            level: "debug",
            source: "collab.draft_review",
            name: "apply.measured",

            payload: measurement,
          });
      },
    }),
  });
  const branches = createWorkBranchReviewService({
    applyClick,
    branches: workBranches,
    reviewItems,
    identity,
    discard,
    commands,
    resolveThreadTitles: lookups.resolveThreadTitles,
    pending: workBranchPendingStore,
  });
  const draftPeers = scopeDraftPeer(
    createEffectiveDocumentReader({
      drafts,
      draftPulls,
      agentEdit,
      documents: runtime.markdownDocuments,
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      branches: workBranches,
    }),
    deps.links,
  );

  const replaceAuthorityGeneration = createDrizzleAuthorityGenerationReplacement({
    db: deps.db,
    coordinator: liveCoordinator,
    checkpoints: persistence.store,
    disconnectGeneration: hocuspocusPersistence.disconnectLiveGeneration,
    onReplaced: derivations.schedule,
  });
  const checkpoints = createCheckpointService({
    coordinator: liveCoordinator,
    store: persistence.store,
    journal: persistence.journal,
    markdownDocuments: runtime.markdownDocuments,
    replaceAuthorityGeneration,
  });
  const lineageStore = createDrizzleTurnLiveLineageStore(deps.db);
  const lineage = createTurnLiveLineageReadModel({
    store: lineageStore,
    receiptStore: turnInverse,
    resolveDocumentUri: documentUriResolver,
    resolveLastDocumentUri: async (documentId) =>
      (await documentLastAddress(documentId))?.uri ?? null,
  });
  const turnReversal = createTurnReversalService({
    turnInverse,
    resolveDocumentUri: documentUriResolver,
    listTurnTargets: lineageStore.listEditedDocumentIdsForTurn,
    threadContext:
      deps.threadContext ?? UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS.threadContext,
  });
  return createCollabFacade({
    lifecycle: {
      dispose: () => {
        draftPulls.cancelScheduledPulls();
        draftAheads.cancelScheduled();
        draftEffects.dispose();
      },
    },
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      primeReservedNamespaceIndex,
      headSchemaVersion: persistence.journal.headSchemaVersion,
      resolveDraftHocuspocusRoom: hocuspocusPersistence.resolveDraftHocuspocusRoom,
      loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,
      loadHocuspocusDraftState: hocuspocusPersistence.loadHocuspocusDraftState,
      admitLiveWriterUpdate: hocuspocusPersistence.admitLiveWriterUpdate,
      currentLiveGeneration: hocuspocusPersistence.currentLiveGeneration,
      async roomRemoval(room) {
        const documentId =
          "documentId" in room
            ? room.documentId
            : (await drafts.getDraft(room.draftId))?.documentId;
        if (!documentId) return null;
        const removal = (await readRemovalRecords(deps.db, [documentId])).get(documentId);
        return removal ? { documentId, removal } : null;
      },
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
      treeHistory: () => treeHistory,
    },
    reversal: turnReversal,
    documents: {
      initializeEmptyDocument: runtime.markdownDocuments.initializeEmptyDocument,
      repairDocumentAuthority: runtime.markdownDocuments.repairDocumentAuthority,
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
      documentDerivations: derivations,
      refreshDocumentProjection: projectionRefresher.refresh,
      draftEffects: { sweep: draftEffects.sweep, flush: draftEffects.flush },
    },
    lineage,
    responses: responseFinalizer,
    checkpoints,
    attribution: createDocumentAttribution({ latestUpdate: persistence.store.latestUpdate }),
    draftAttribution: {
      readDraftProvenance: createDraftProvenanceReader(createDrizzleDraftDispositionStore(deps.db)),
    },
    draftPeers,
    branches,
    branchResolver: {
      branches: workBranches,
      draftLinks: draftAheads,
      workBranchDisposal: createDrizzleWorkBranchDisposal(deps.db, {
        removal: deps.documentRemoval,
        close: deps.draftClose,
        branches: workBranches,
        catalog: deps.catalogMutations,
      }),
    },
    documentCreation,
  });
}
