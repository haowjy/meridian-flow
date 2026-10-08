/** Production dependency graph for the server collab domain. */

import type { Database } from "@meridian/database";
import type { AssetPathResolver } from "@meridian/markup";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  deferUntilDrizzleRollback,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} from "../../shared/drizzle-transaction.js";
import { lockWorksInIdOrder } from "../../shared/work-lifecycle-lock.js";
import {
  createDocumentUriResolver,
  createDocumentUrisResolver,
  resolveDocumentUri,
} from "../context/document-uri-resolver.js";
import type { FileAccess } from "../file-policy/index.js";
import type { NoticePort } from "../notices/index.js";
import { type EventSink, emitEvent } from "../observability/index.js";
import type { ProjectWorkAuthorityResolver, WorkProjectionMutation } from "../projects/index.js";
import {
  createAgentEditInvariantDiagnostic,
  createAgentEditObservabilityOptions,
  createBranchAgentEditDiagnostics,
  createBranchPullDiagnostics,
  createDocumentProjectionDiagnostics,
  createDraftReviewDiagnostics,
  createMarkdownSerializationAnomalyObserver,
  createResponseTransactionDiagnostics,
  createReversalNoticeDiagnostics,
  createSweepProjectionDiagnostics,
} from "./adapters/agent-edit-observability.js";
import {
  SILENT_POST_DURABILITY_NOTICES,
  UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
} from "./adapters/declared-stubs.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
  createDrizzleWorkDraftPendingStore,
  createDrizzleWorkPushPolicyStore,
} from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleCollabLookups } from "./adapters/drizzle-collab-lookups.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import {
  createDrizzleAuthorityGenerationReader,
  createDrizzleDocumentAuthorityHeads,
} from "./adapters/drizzle-document-authority-head.js";
import { createDrizzleDocumentDerivationStore } from "./adapters/drizzle-document-derivations.js";
import { createDrizzleDocumentLinkRewrite } from "./adapters/drizzle-document-link-rewrite.js";
import { createDrizzleDraftReviewLive } from "./adapters/drizzle-draft-review-live.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createDrizzleLiveTurnDependencyStore } from "./adapters/drizzle-live-dependencies.js";
import { createDrizzleOfflineReconciliation } from "./adapters/drizzle-offline-reconciliation.js";
import {
  createDrizzlePendingSettlementStore,
  stagePendingSettlementWithinTx,
} from "./adapters/drizzle-pending-settlement.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleTurnReceiptStore } from "./adapters/drizzle-turn-receipt.js";
import {
  createDrizzleEmptyDraftSettlement,
  createDrizzleWorkDraftDiscard,
} from "./adapters/drizzle-work-draft-discard.js";
import { createHocuspocusBinding } from "./adapters/hocuspocus-binding.js";
import { createHocuspocusChangeEventDelivery } from "./adapters/hocuspocus-change-event-delivery.js";
import {
  createDeferredLiveProjectionCoordinator,
  createHocuspocusCoordinator,
} from "./adapters/hocuspocus-coordinator.js";
import { createWriterIngressBinding } from "./adapters/writer-ingress-binding.js";
import { createCheckpointService } from "./checkpoints.js";
import { createCollabFacade } from "./collab-facade.js";
import type { CollabDomain } from "./contracts.js";
import { createAgentEditRuntime, metaForOrigin } from "./domain/agent-edit-runtime.js";
import { createBranchConcurrentJournalWatermarks } from "./domain/branch-agent-edit.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchCriticalSections } from "./domain/branch-critical-sections.js";
import { createBranchPullService } from "./domain/branch-pulls.js";
import { createBranchPushService } from "./domain/branch-push.js";
import { createBranchReviewOperations } from "./domain/branch-review-operations.js";
import { createDocumentAttribution } from "./domain/document-attribution.js";
import { createDocumentCreationAggregate } from "./domain/document-creation.js";
import { createDocumentDerivationService } from "./domain/document-derivations.js";
import {
  createDocumentWriteHookRunner,
  createProjectionEffectsDocumentWriteHook,
} from "./domain/document-projection-refresher.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import { primeReservedNamespaceIndex } from "./domain/provenance.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "./domain/response-transaction.js";
import {
  createResponseBranchFinalization,
  createResponseWriteFinalizer,
} from "./domain/response-write-finalizer.js";
import {
  createDocumentPresentationResolver,
  createPostDurabilityNoticeService,
  createReversalNoticePort,
} from "./domain/reversal-notices.js";
import { createBranchThreadPeerAgentEditCore } from "./domain/thread-peer-core-pool.js";
import { createTurnLiveLineageReadModel } from "./domain/turn-live-lineage.js";
import {
  createTurnReversalService,
  type ThreadContextReversalResolver,
} from "./domain/turn-reversal-service.js";
import { createWorkDraftPending } from "./domain/work-draft-pending.js";
import { createWorkDraftReviewService } from "./domain/work-draft-review-service.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";

export type { DocumentWriteHook } from "./contracts.js";

type CollabDomainDeps = {
  db: Database;
  /** Project asset index threaded to the markup codec at the composition root. */
  assetPathResolver?: AssetPathResolver;
  threadContext?: ThreadContextReversalResolver;
  eventSink?: EventSink;
  notices?: NoticePort;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  workProjectionMutation: WorkProjectionMutation;
  /**
   * Confirms writes' grants under lock where they become durable (file-access
   * §5); the writer's turn undo also asks it for its grants.
   */
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  /** How long a live AI write waits before merging into Work drafts; tests shorten it. */
  livePullDebounceMs?: number;
};

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const persistence = createDrizzleCollabPersistence(deps.db);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => runInDrizzleTransaction(deps.db, operation),
    ensureDocument: persistence.lifecycle.ensureDocument,
  });
  const hocuspocusBinding = createHocuspocusBinding(deps.eventSink);
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: hocuspocusBinding.require,
    journal: persistence.journal,
  });
  const criticalSections = createBranchCriticalSections();
  const branches = createDrizzleBranchStore(
    deps.db,
    {
      journal: persistence.journal,
      lifecycle: persistence.lifecycle,
      coordinator: liveCoordinator,
    },
    criticalSections,
    deps.workProjectionMutation,
  );
  const branchCoordinator = createBranchCoordinator({
    store: branches,
    criticalSections,
    onBranchUpdate: hocuspocusBinding.publishBranchUpdate,
    onBranchReset: ({ branchId }) => hocuspocusBinding.closeBranch(branchId),
  });
  const concurrentJournalWatermarks = createBranchConcurrentJournalWatermarks();
  const branchPulls = createBranchPullService({
    // A pull isn't the write that scheduled it: it leaves that write's grants too.
    outsideTransaction: runOutsideWrite,
    rootTransaction: (operation) => runInRootDrizzleTransaction(deps.db, operation),
    liveCoordinator,
    branchCoordinator,
    branches,
    concurrentJournalWatermarks,
    liveJournal: persistence.journal,
    diagnostics: createBranchPullDiagnostics(deps.eventSink),
    ...(deps.livePullDebounceMs === undefined ? {} : { debounceMs: deps.livePullDebounceMs }),
  });

  const documentUriResolver = createDocumentUriResolver(deps.db, deps.workAuthorityResolver);
  const documentPresentation = createDocumentPresentationResolver(documentUriResolver);
  const lookups = createDrizzleCollabLookups(deps.db);
  const changeTrails = createDrizzleChangeTrailAggregateWriter(deps.db);
  const projectionEffects = createDrizzleDocumentProjectionEffects(
    deps.db,
    deps.workProjectionMutation,
  );
  const projectionDiagnostics = createDocumentProjectionDiagnostics(deps.eventSink);
  const noticeDiagnostics = createReversalNoticeDiagnostics(deps.eventSink);
  const derivationStore = createDrizzleDocumentDerivationStore(deps.db, (tx, documentId) =>
    resolveDocumentUri(tx, deps.workAuthorityResolver, documentId),
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
  const reversalNoticePort = deps.notices
    ? createReversalNoticePort({
        notices: deps.notices,
        documentUriResolver,
        diagnostics: noticeDiagnostics,
      })
    : undefined;
  const observability = createAgentEditObservabilityOptions({
    eventSink: deps.eventSink,
    reversalNoticePort,
  });
  const responseTransactionDiagnostics = createResponseTransactionDiagnostics(deps.eventSink);
  const runtime = createAgentEditRuntime({
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
    lifecycle: documentCreation,
    initialDocumentSeeds: persistence.lifecycle,
    deferUntilCommit: deferUntilDrizzleCommit,
    runDocumentWriteHook,
    resolveDocumentFiletype: lookups.resolveDocumentFiletype,
    observability,
    assetPathResolver: deps.assetPathResolver,
    observeSerializationAnomaly: createMarkdownSerializationAnomalyObserver(deps.eventSink),
  });
  const projectionRefresher = { refresh: runDocumentWriteHook };

  const pendingSettlements = createDrizzlePendingSettlementStore(
    deps.db,
    runtime.markdownDocuments,
    projectionEffects,
    changeTrails,
    derivationStore,
    deps.notices,
    deps.eventSink,
  );
  const branchJournal = createDrizzleBranchJournalReadStore(deps.db);
  const pushCommits = createDrizzlePushCommitStore(
    deps.db,
    stagePendingSettlementWithinTx,
    changeTrails,
    deps.notices,
    deps.workProjectionMutation,
  );
  const workPushPolicy = createDrizzleWorkPushPolicyStore(deps.db, deps.workProjectionMutation);
  const workDraftPendingStore = createDrizzleWorkDraftPendingStore(deps.db);
  const workDraftPending = createWorkDraftPending(workDraftPendingStore);
  const writerIngress = createWriterIngressBinding();
  const branchPush = createBranchPushService({
    branchStore: branches,
    criticalSections,
    journalReadStore: branchJournal,
    commitStore: pushCommits,
    workPushPolicyStore: workPushPolicy,
    workDraftPendingStore,
    settlementStore: pendingSettlements,
    branchCoordinator,
    journal: persistence.journal,
    liveCoordinator,
    model: runtime.model,
    codec: runtime.markupCodec,
    changeEventDelivery: createHocuspocusChangeEventDelivery({
      hocuspocus: hocuspocusBinding.require,
      eventSink: deps.eventSink,
    }),
    writerIngressBarrier: writerIngress.barrier,
    sweepProjectionDiagnostics: createSweepProjectionDiagnostics(deps.eventSink),
    resolveDocumentTitle: documentPresentation.resolveTitle,
  });
  const branchReview = createBranchReviewOperations({
    branchStore: branches,
    journalReadStore: branchJournal,
    commitStore: pushCommits,
    branchCoordinator,
    journal: persistence.journal,
    criticalSections,
    deferUntilCommit: deferUntilDrizzleCommit,
  });

  const agentEdit = createBranchThreadPeerAgentEditCore({
    liveUtilityCore: runtime.liveUtilityCore,
    fileAccess: deps.fileAccess,
    async lockWorks(workIds) {
      await lockWorksInIdOrder(currentDrizzleDb(deps.db), workIds);
    },
    async lockLiveDocuments(documentIds) {
      const tx = currentDrizzleDb(deps.db);
      for (const documentId of documentIds) await lockDocumentMutation(tx, documentId);
    },
    journal: persistence.journal,
    liveCoordinator,
    lifecycle: persistence.lifecycle,
    branches,
    branchCoordinator,
    branchPulls,
    branchJournal,
    concurrentJournalWatermarks,
    diagnostics: createBranchAgentEditDiagnostics(deps.eventSink),
    afterCommit: runAfterDrizzleCommit,
    enlistResponseParticipant,
    model: runtime.model,
    codec: runtime.codec,
    semanticProvenance: runtime.semanticProvenance,
    observability,
    commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(deps.db, operation),
    responseTransactionSettlement: {
      deferUntilCommit: deferUntilDrizzleCommit,
      deferUntilRollback: deferUntilDrizzleRollback,
    },
    responseTransactions: {
      enlist: enlistResponseParticipant,
      run: (atomic, operation, settlement) =>
        runResponseTransaction(atomic, operation, settlement, responseTransactionDiagnostics),
    },
  });

  const offlineReconciliation = createDrizzleOfflineReconciliation({
    journal: persistence.journal,
    changeTrails,
    model: runtime.model,
    codec: runtime.codec,
    resolveTurnThreadId: lookups.resolveTurnThreadId,
    resolveDocumentUri: documentUriResolver,
  });
  const authorityGeneration = createDrizzleAuthorityGenerationReader(deps.db);
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal: persistence.journal,
    branchStore: branches,
    branchCoordinator,
    hocuspocus: hocuspocusBinding.current,
    eventSink: deps.eventSink,
    metaForOrigin,
    latestUpdateSeq: persistence.store.latestUpdateSeq,
    afterCallerCommit: (callback) => {
      runAfterDrizzleCommit(callback);
    },
    readAuthorityHeadGeneration: authorityGeneration,
    emitAgentEditInvariantViolation: createAgentEditInvariantDiagnostic(deps.eventSink),
    onLiveUpdatePersisted: (documentId) => {
      branchPulls.scheduleLivePull(documentId);
      derivations.schedule(documentId);
    },
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
  const liveDependencies = createDrizzleLiveTurnDependencyStore(deps.db);
  const responseFinalizer = createResponseWriteFinalizer({
    agentEdit,
    liveAgentEdit: runtime.liveUtilityCore,
    reversalStore: persistence.journal,
    liveReversal: liveDependencies,
    resolveDocumentUri: documentUriResolver,
    branches: createResponseBranchFinalization({
      branches,
      branchCoordinator,
      branchJournal,
      branchReview,
    }),
    projections: projectionRefresher,
    notices: postDurabilityNotices,
    deferUntilCommit: deferUntilDrizzleCommit,
  });
  const drafts = createWorkDraftReviewService({
    diagnostics: createDraftReviewDiagnostics(deps.eventSink),
    settleEmptyDraft: createDrizzleEmptyDraftSettlement(
      deps.db,
      branches,
      branchCoordinator,
      criticalSections,
      liveCoordinator,
      branchJournal,
    ),
    discardWorkDraft: createDrizzleWorkDraftDiscard(
      deps.db,
      branches,
      branchCoordinator,
      criticalSections,
      liveCoordinator,
    ),
    branches,
    branchCoordinator,
    branchJournal,
    branchPush,
    branchReview,
    workDraftPending,
    documents: runtime.markdownDocuments,
    model: runtime.model,
    agentEdit,
    resolveDocumentUris: createDocumentUrisResolver(deps.db, deps.workAuthorityResolver),
    resolveThreadTitles: lookups.resolveThreadTitles,
    readLiveReviewCut: createDrizzleDraftReviewLive(deps.db, persistence.journal),
  });
  const branchPeers = createEffectiveDocumentReader({
    branches,
    branchCoordinator,
    branchPulls,
    liveCoordinator,
    agentEdit,
    documents: runtime.markdownDocuments,
    model: runtime.model,
    codec: runtime.codec,
  });

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
    latestUpdateSeq: persistence.store.latestUpdateSeq,
    markdownDocuments: runtime.markdownDocuments,
    replaceAuthorityGeneration,
  });
  const lineage = createTurnLiveLineageReadModel({
    store: createDrizzleTurnLiveLineageStore(deps.db),
    receiptStore: createDrizzleTurnReceiptStore(deps.db),
    resolveDocumentUri: documentUriResolver,
  });
  const turnReversal = createTurnReversalService({
    atomic: (operation) => runInDrizzleTransaction(deps.db, operation),
    live: {
      reversalStore: persistence.journal,
      agentEdit: runtime.liveUtilityCore,
      resolveDocumentUri: documentUriResolver,
      checkDependentLaterLiveRows: liveDependencies.checkDependentLaterLiveRows,
      refreshDocumentProjection: projectionRefresher.refresh,
      deferUntilCommit: deferUntilDrizzleCommit,
    },
    agentEdit,
    branchReview,
    branchJournal,
    branches,
    resolveDocumentUri: documentUriResolver,
    listEditedDocumentsForTurn: lineage.listEditedDocumentsForTurn,
    fileAccess: deps.fileAccess,
    threadContext:
      deps.threadContext ?? UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS.threadContext,
  });
  return createCollabFacade({
    lifecycle: { dispose: () => branchPulls.cancelScheduledPulls() },
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      primeReservedNamespaceIndex,
      headSchemaVersion: persistence.journal.headSchemaVersion,
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
    authorityHeads: createDrizzleDocumentAuthorityHeads(deps.db),
    agentEdit: {
      agentEdit: () => agentEdit,
    },
    reversal: turnReversal,
    documents: {
      ensureDocument: persistence.lifecycle.ensureDocument,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      writeDocument: runtime.markdownDocuments.writeDocument,
      editDocument: runtime.markdownDocuments.editDocument,
    },
    projections: {
      documentDerivations: derivations,
      rewriteDocumentLinks: createDrizzleDocumentLinkRewrite({
        db: deps.db,
        resolveUri: (tx, documentId) =>
          resolveDocumentUri(tx, deps.workAuthorityResolver, documentId),
        serializer: runtime.markdownDocuments,
        publish(documentId, update) {
          const room = hocuspocusBinding.current()?.documents.get(documentId);
          if (room)
            Y.applyUpdate(room, update, {
              source: "local",
              context: { origin: { type: "system", reason: "link-update" } },
            });
          branchPulls.scheduleLivePull(documentId);
        },
      }),
      refreshDocumentProjection: projectionRefresher.refresh,
    },
    lineage,
    responses: responseFinalizer,
    checkpoints,
    attribution: createDocumentAttribution({
      latestUpdate: persistence.store.latestUpdate,
    }),
    branchPush: {
      recoverPendingLiveSettlements: branchPush.recoverPendingLiveSettlements,
      pushToLive: branchPush.pushToLive,
      countPendingByWorkIds: workDraftPending.countPendingByWorkIds,
      setWorkPushPolicy: branchPush.setWorkPushPolicy,
      markFailedResponseRollbackPending: branchReview.markFailedResponseRollbackPending,
    },
    branchPeers,
    drafts,
    documentCreation,
  });
}
