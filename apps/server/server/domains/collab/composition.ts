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
import { lockDocumentNamespaces } from "../context/adapters/context-fs/document-locations.js";
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
  createDraftReviewDiagnostics,
  createMarkdownSerializationAnomalyObserver,
  createResponseTransactionDiagnostics,
  createReversalNoticeDiagnostics,
  createRewriteCommittedEvent,
  createRoomDeliveryDiagnostics,
  createSweepProjectionDiagnostics,
  createWriterFrameDiagnostics,
} from "./adapters/agent-edit-observability.js";
import {
  SILENT_POST_DURABILITY_NOTICES,
  SILENT_TURN_INVERSE_NOTICES,
  UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
} from "./adapters/declared-stubs.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import { createDrizzleBranchCommands } from "./adapters/drizzle-branch-commands.js";
import {
  createDrizzleBranchDiscard,
  createDrizzleWorkBranchDisposal,
} from "./adapters/drizzle-branch-discard.js";
import {
  createDrizzleDraftJournalReadStore,
  createDrizzlePushCommitStore,
} from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchTreeStep } from "./adapters/drizzle-branch-tree-step.js";
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
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createDrizzleOfflineReconciliation } from "./adapters/drizzle-offline-reconciliation.js";
import {
  createDrizzlePendingSettlementStore,
  stageSettlementBatchWithinTx,
} from "./adapters/drizzle-pending-settlement.js";
import { createDrizzleReviewCut, readLiveDoc } from "./adapters/drizzle-review-cut.js";
import { createDrizzleTurnInverseService } from "./adapters/drizzle-turn-inverse.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import { createHocuspocusBinding } from "./adapters/hocuspocus-binding.js";
import { createHocuspocusChangeEventDelivery } from "./adapters/hocuspocus-change-event-delivery.js";
import {
  createDeferredLiveProjectionCoordinator,
  createHocuspocusCoordinator,
} from "./adapters/hocuspocus-coordinator.js";
import { createLiveFingerprintReader } from "./adapters/live-fingerprint-reader.js";
import { createWriterIngressBinding } from "./adapters/writer-ingress-binding.js";
import { createCheckpointService } from "./checkpoints.js";
import { createCollabFacade } from "./collab-facade.js";
import type { CollabDomain } from "./contracts.js";
import { createAgentEditRuntime, metaForOrigin } from "./domain/agent-edit-runtime.js";
import { createBranchApply } from "./domain/branch-apply.js";
import { createBranchDiscard } from "./domain/branch-discard.js";
import { createBranchPushService } from "./domain/branch-push.js";
import { fullStateFingerprint } from "./domain/branch-push-transition.js";
import { createBranchReviewIdentity } from "./domain/branch-review-identity.js";
import { createBranchReviewItems } from "./domain/branch-review-items.js";
import { createBranches } from "./domain/branches.js";
import { createDocumentAttribution } from "./domain/document-attribution.js";
import { createDocumentCreationAggregate } from "./domain/document-creation.js";
import { createDocumentDerivationService } from "./domain/document-derivations.js";
import {
  scopeAgentEdit,
  scopeDraftPeer,
  scopeOfflineReconciliation,
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
import { createDraftPullService } from "./domain/draft-pulls.js";
import { createDraftRetirement } from "./domain/draft-retirement.js";
import { createDraftReviewOperations } from "./domain/draft-review-operations.js";
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
  createDocumentPresentationResolver,
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
  /** Stops staging new Applies while settlement drains (cutover); staged ones complete. */
  drainSettlement?: boolean;
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
          onAppendSequenced: createAppendCommittedEvent(deps.eventSink),
        }
      : {}),
  });
  const writerFrameDiagnostics = createWriterFrameDiagnostics(deps.eventSink);
  const draftJournal = createDrizzleDraftJournalReadStore(deps.db);
  const draftCoordinator = createDraftCoordinator({
    store: drafts,
    attemptScope,
    onDraftUpdate: hocuspocusBinding.deliverDraftUpdate,
    onDraftReset: ({ draftId, generation }) => hocuspocusBinding.closeDraft(draftId, generation),
    applyToRoom: hocuspocusBinding.applyToRoom,
    diagnostics: writerFrameDiagnostics,
    // The projection is composed below, over the coordinator; a mark only fires after a commit.
    onAppendCommitted: (draftId) => draftEffects.markDirty(draftId),
  });
  const draftPulls = createDraftPullService({
    // A pull isn't the write that scheduled it: it leaves that write's grants too.
    outsideTransaction: runOutsideWrite,
    liveCoordinator,
    draftCoordinator,
    drafts,
    diagnostics: createDraftPullDiagnostics(deps.eventSink),
    ...(deps.livePullDebounceMs === undefined ? {} : { debounceMs: deps.livePullDebounceMs }),
  });
  const draftEffects = createDraftProjection({
    coordinator: draftCoordinator,
    store: drafts,
    pulls: draftPulls,
    diagnostics: createDraftProjectionDiagnostics(deps.eventSink),
    outsideTransaction: runOutsideWrite,
  });

  const documentUriResolver = createDocumentUriResolver(deps.db);
  const documentPresentation = createDocumentPresentationResolver(documentUriResolver);
  const lookups = createDrizzleCollabLookups(deps.db);
  const changeTrails = createDrizzleChangeTrailAggregateWriter(deps.db);
  const projectionEffects = createDrizzleDocumentProjectionEffects(
    deps.db,
    deps.workProjectionMutation,
  );
  const projectionDiagnostics = createDocumentProjectionDiagnostics(deps.eventSink);
  const noticeDiagnostics = createReversalNoticeDiagnostics(deps.eventSink);
  const derivationStore = createDrizzleDocumentDerivationStore(
    deps.db,
    createDocumentLastAddress(deps.db),
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
  const pendingSettlements = createDrizzlePendingSettlementStore(
    deps.db,
    runtime.markdownDocuments,
    projectionEffects,
    changeTrails,
    derivationStore,
    deps.notices,
    deps.eventSink,
    {
      namespaces: {
        lockNamespaces: ({ documentIds, sourceIds }) =>
          lockDocumentNamespaces(deps.db, documentIds, sourceIds),
      },
      // Apply's tree work lands with the text it applies (contract §11.2).
      steps: [
        createDrizzleBranchTreeStep(deps.db, {
          branches: workBranches,
          drafts,
          coordinator: draftCoordinator,
          liveDoc: (documentId) => readLiveDoc(persistence.journal, documentId),
          ...(deps.arrivals ? { arrivals: deps.arrivals } : {}),
          catalog: deps.catalogMutations,
        }),
      ],
    },
    deps.workProjectionMutation,
  );
  const pushCommits = createDrizzlePushCommitStore(
    deps.db,
    stageSettlementBatchWithinTx,
    changeTrails,
    deps.notices,
    deps.workProjectionMutation,
  );
  const writerIngress = createWriterIngressBinding();
  const branchPush = createBranchPushService({
    draftStore: drafts,
    journalReadStore: draftJournal,
    commitStore: pushCommits,
    settlementStore: pendingSettlements,
    journal: persistence.journal,
    liveCoordinator,
    model: runtime.model,
    codec: runtime.codec,
    links: deps.links,
    changeEventDelivery: createHocuspocusChangeEventDelivery({
      hocuspocus: hocuspocusBinding.require,
      eventSink: deps.eventSink,
    }),
    writerIngressBarrier: writerIngress.barrier,
    sweepProjectionDiagnostics: createSweepProjectionDiagnostics(deps.eventSink),
    resolveDocumentTitle: documentPresentation.resolveTitle,
  });
  const draftReview = createDraftReviewOperations({
    draftStore: drafts,
    journalReadStore: draftJournal,
    commitStore: pushCommits,
    draftCoordinator,
    journal: persistence.journal,
    attemptScope,
  });

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
      draftJournal,
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

  const offlineReconciliation = scopeOfflineReconciliation(
    createDrizzleOfflineReconciliation({
      journal: persistence.journal,
      changeTrails,
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      resolveTurnThreadId: lookups.resolveTurnThreadId,
      resolveDocumentUri: documentUriResolver,
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
    offlineReconciliation,
  });
  writerIngress.bind(hocuspocusPersistence.writerIngressBarrier);

  const postDurabilityNotices = deps.notices
    ? createPostDurabilityNoticeService({
        notices: deps.notices,
        documentUriResolver,
        diagnostics: noticeDiagnostics,
      })
    : SILENT_POST_DURABILITY_NOTICES;
  const turnInverse = createDrizzleTurnInverseService({
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
      workBranchPendingStore.listBranchDraftEvidence(branchId, documentIds),
    creators: (branchId, documentIds) => workBranchPendingStore.listCreators(branchId, documentIds),
    settling: (branchId) => workBranchPendingStore.listSettling(branchId),
    liveFingerprint: createLiveFingerprintReader({
      db: deps.db,
      roomOpen: (documentId) => {
        const hocuspocus = hocuspocusBinding.current();
        return Boolean(
          hocuspocus?.documents.has(documentId) || hocuspocus?.loadingDocuments.has(documentId),
        );
      },
      read: (documentId) =>
        liveCoordinator.withDocument(documentId, async (doc) => fullStateFingerprint(doc)),
    }),
  });
  const branchApply = createBranchApply({
    branches: workBranches,
    reviewItems,
    push: branchPush,
    ...(deps.drainSettlement ? { drainSettlement: true } : {}),
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
    drafts,
    coordinator: draftCoordinator,
    workProjection: deps.workProjectionMutation,
    catalog: deps.catalogMutations,
  });
  const discard = createBranchDiscard({
    branches: workBranches,
    liveCoordinator,
    store: discardStore,
    holdRetirement: deps.draftClose.holdRetirement,
    releaseObjects: (storageUrls) => deps.objects?.storageUrls(storageUrls) ?? Promise.resolve(),
    attemptScope,
  });
  const identity = createBranchReviewIdentity({ branches: workBranches, reviewItems });
  const branches = createWorkBranchReviewService({
    diagnostics: createDraftReviewDiagnostics(deps.eventSink),
    branches: workBranches,
    reviewItems,
    identity,
    branchApply,
    discard,
    draftReview,
    commands: createDrizzleBranchCommands(deps.db),
    model: runtime.model,
    resolveThreadTitles: lookups.resolveThreadTitles,
    pending: workBranchPendingStore,
    readReviewCut: createDrizzleReviewCut({
      db: deps.db,
      journal: persistence.journal,
      drafts,
      rows: draftJournal,
      links: deps.links,
      identity,
      resolveThreadTitles: lookups.resolveThreadTitles,
    }),
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
  const lineage = createTurnLiveLineageReadModel({
    store: createDrizzleTurnLiveLineageStore(deps.db),
    receiptStore: turnInverse,
    resolveDocumentUri: documentUriResolver,
  });
  const turnReversal = createTurnReversalService({
    turnInverse,
    resolveDocumentUri: documentUriResolver,
    listEditedDocumentsForTurn: lineage.listEditedDocumentsForTurn,
    fileAccess: deps.fileAccess,
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
      writerIngressBarrier: hocuspocusPersistence.writerIngressBarrier,
      persistConnectionUpdate: hocuspocusPersistence.persistConnectionUpdate,
      storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,
      storeHocuspocusDraft: hocuspocusPersistence.storeHocuspocusDraft,
      drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,
      drainHocuspocusDraftPersistence: hocuspocusPersistence.drainHocuspocusDraftPersistence,
      closeHocuspocusDraftRoom: hocuspocusPersistence.closeHocuspocusDraftRoom,
      rejectStaleDraftSyncStep1: hocuspocusPersistence.rejectStaleDraftSyncStep1,
      enrollHocuspocusDraftRoom: hocuspocusPersistence.enrollHocuspocusDraftRoom,
      getPersistenceQueueMetrics: hocuspocusPersistence.getPersistenceQueueMetrics,
    },
    agentEdit: {
      agentEdit: () => agentEdit,
    },
    reversal: turnReversal,
    documents: {
      initializeEmptyDocument: runtime.markdownDocuments.initializeEmptyDocument,
      repairDocumentAuthority: runtime.markdownDocuments.repairDocumentAuthority,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      readCopySource: runtime.markdownDocuments.readCopySource,
      seedFromNodes: runtime.markdownDocuments.seedFromNodes,
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
    attribution: createDocumentAttribution({
      latestUpdate: persistence.store.latestUpdate,
    }),
    branchPush: {
      recoverPendingLiveSettlements: branchPush.recoverPendingLiveSettlements,
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
