/** Production dependency graph for the server collab domain. */
import type { Database } from "@meridian/database";
import {
  deferUntilDrizzleCommit,
  deferUntilDrizzleRollback,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { createDocumentUriResolver } from "../context/document-uri-resolver.js";
import type { NoticePort } from "../notices/index.js";
import type { EventSink } from "../observability/index.js";
import {
  createAgentEditInvariantDiagnostic,
  createAgentEditObservabilityOptions,
  createBranchAgentEditDiagnostics,
  createDocumentProjectionDiagnostics,
  createReversalNoticeDiagnostics,
} from "./adapters/agent-edit-observability.js";
import { SILENT_POST_DURABILITY_NOTICES } from "./adapters/declared-stubs.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
  createDrizzleWorkPushPolicyStore,
} from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleChangeTrailPersistence } from "./adapters/drizzle-change-trails.js";
import { createDrizzleCollabLookups } from "./adapters/drizzle-collab-lookups.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import {
  createDrizzleAuthorityGenerationReader,
  createDrizzleDocumentAuthorityHeads,
} from "./adapters/drizzle-document-authority-head.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createDrizzleLiveTurnDependencyStore } from "./adapters/drizzle-live-dependencies.js";
import { createDrizzleOfflineReconciliation } from "./adapters/drizzle-offline-reconciliation.js";
import {
  createDrizzlePendingSettlementStore,
  stagePendingSettlementWithinTx,
} from "./adapters/drizzle-pending-settlement.js";
import {
  createDrizzleTrailForwardActions,
  type TrailDocumentAccess,
} from "./adapters/drizzle-trail-forward-actions.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleTurnReceiptStore } from "./adapters/drizzle-turn-receipt.js";
import { createHocuspocusBinding } from "./adapters/hocuspocus-binding.js";
import { createHocuspocusCoordinator } from "./adapters/hocuspocus-coordinator.js";
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
import {
  createDocumentProjectionRefresher,
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
import { createTurnReversalService } from "./domain/turn-reversal-service.js";
import { createWorkDraftReviewService } from "./domain/work-draft-review-service.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";

export type { DocumentWriteHook } from "./contracts.js";

type CollabDomainDeps = {
  db: Database;
  documentAccess: TrailDocumentAccess & {
    canAccessDocument(
      userId: import("@meridian/contracts/runtime").UserId,
      documentId: string,
    ): Promise<boolean>;
    canAccessProjectDocument(
      userId: import("@meridian/contracts/runtime").UserId,
      documentId: string,
      projectId: import("@meridian/contracts/runtime").ProjectId,
    ): Promise<boolean>;
  };
  threadContext?: import("./domain/turn-reversal-service.js").ThreadContextReversalResolver;
  eventSink?: EventSink;
  notices?: NoticePort;
};

const UNAVAILABLE_THREAD_CONTEXT_REVERSAL: import("./domain/turn-reversal-service.js").ThreadContextReversalResolver =
  {
    async requireThreadOwner() {
      throw new Error("Thread context reversal is not configured");
    },
    async resolveContextDocument() {
      throw new Error("Thread context reversal is not configured");
    },
  };

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const persistence = createDrizzleCollabPersistence(deps.db);
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
  );
  const branchCoordinator = createBranchCoordinator({
    store: branches,
    criticalSections,
    onBranchUpdate: hocuspocusBinding.publishBranchUpdate,
    onBranchReset: ({ branchId }) => hocuspocusBinding.closeBranch(branchId),
  });
  const concurrentJournalWatermarks = createBranchConcurrentJournalWatermarks();
  const branchPulls = createBranchPullService({
    liveCoordinator,
    branchCoordinator,
    branches,
    concurrentJournalWatermarks,
    liveJournal: persistence.journal,
  });

  const documentUriResolver = createDocumentUriResolver(deps.db);
  const documentPresentation = createDocumentPresentationResolver(documentUriResolver);
  const lookups = createDrizzleCollabLookups(deps.db);
  const changeTrails = createDrizzleChangeTrailPersistence(deps.db);
  const projectionEffects = createDrizzleDocumentProjectionEffects(deps.db);
  const projectionDiagnostics = createDocumentProjectionDiagnostics(deps.eventSink);
  const noticeDiagnostics = createReversalNoticeDiagnostics(deps.eventSink);
  const documentWriteHook = createProjectionEffectsDocumentWriteHook(projectionEffects);
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
  const runtime = createAgentEditRuntime({
    journal: persistence.journal,
    coordinator: liveCoordinator,
    lifecycle: persistence.lifecycle,
    initialDocumentSeeds: persistence.lifecycle,
    runDocumentWriteHook,
    resolveDocumentFiletype: lookups.resolveDocumentFiletype,
    observability,
  });
  const projectionRefresher = createDocumentProjectionRefresher({
    documents: runtime.markdownDocuments,
    runDocumentWriteHook,
    diagnostics: projectionDiagnostics,
  });

  const pendingSettlements = createDrizzlePendingSettlementStore(
    deps.db,
    runtime.markdownDocuments,
    projectionEffects,
    changeTrails,
    deps.notices,
  );
  const branchJournal = createDrizzleBranchJournalReadStore(deps.db);
  const pushCommits = createDrizzlePushCommitStore(
    deps.db,
    stagePendingSettlementWithinTx,
    changeTrails,
    deps.notices,
  );
  const workPushPolicy = createDrizzleWorkPushPolicyStore(deps.db);
  const writerIngress = createWriterIngressBinding();
  const branchPush = createBranchPushService({
    branchStore: branches,
    criticalSections,
    journalReadStore: branchJournal,
    commitStore: pushCommits,
    workPushPolicyStore: workPushPolicy,
    settlementStore: pendingSettlements,
    branchCoordinator,
    journal: persistence.journal,
    liveCoordinator,
    model: runtime.model,
    codec: runtime.markupCodec,
    notices: deps.notices,
    writerIngressBarrier: writerIngress.barrier,
    resolveDocumentTitle: documentPresentation.resolveTitle,
  });
  const branchReview = createBranchReviewOperations({
    branchStore: branches,
    journalReadStore: branchJournal,
    commitStore: pushCommits,
    branchCoordinator,
    journal: persistence.journal,
    criticalSections,
  });

  const agentEdit = createBranchThreadPeerAgentEditCore({
    liveUtilityCore: runtime.liveUtilityCore,
    journal: persistence.journal,
    liveCoordinator,
    lifecycle: persistence.lifecycle,
    branches,
    branchCoordinator,
    branchPulls,
    branchPush,
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
      run: runResponseTransaction,
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
    readAuthorityHeadGeneration: authorityGeneration,
    emitAgentEditInvariantViolation: createAgentEditInvariantDiagnostic(deps.eventSink),
    onLiveUpdatePersisted: branchPulls.scheduleLivePull,
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
  });
  const drafts = createWorkDraftReviewService({
    branches,
    branchCoordinator,
    branchJournal,
    branchPush,
    branchReview,
    workPushPolicy,
    liveCoordinator,
    documents: runtime.markdownDocuments,
    model: runtime.model,
    agentEdit,
    resolveDocumentUri: documentUriResolver,
    latestUpdateSeq: persistence.store.latestUpdateSeq,
  });
  const branchPeers = createEffectiveDocumentReader({
    branches,
    branchCoordinator,
    branchPulls,
    branchPush,
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
  });
  const checkpoints = createCheckpointService({
    coordinator: liveCoordinator,
    store: persistence.store,
    latestUpdateSeq: persistence.store.latestUpdateSeq,
    markdownDocuments: runtime.markdownDocuments,
    notices: deps.notices,
    model: runtime.model,
    codec: runtime.codec,
    replaceAuthorityGeneration,
  });
  const lineage = createTurnLiveLineageReadModel({
    store: createDrizzleTurnLiveLineageStore(deps.db),
    receiptStore: createDrizzleTurnReceiptStore(deps.db),
    resolveDocumentUri: documentUriResolver,
  });
  const turnReversal = createTurnReversalService({
    live: {
      reversalStore: persistence.journal,
      agentEdit: runtime.liveUtilityCore,
      resolveDocumentUri: documentUriResolver,
      checkDependentLaterLiveRows: liveDependencies.checkDependentLaterLiveRows,
      refreshDocumentProjection: projectionRefresher.refresh,
    },
    agentEdit,
    branchReview,
    branchJournal,
    branches,
    resolveDocumentUri: documentUriResolver,
    listEditedDocumentsForTurn: lineage.listEditedDocumentsForTurn,
    documentAccess: deps.documentAccess,
    threadContext: deps.threadContext ?? UNAVAILABLE_THREAD_CONTEXT_REVERSAL,
  });
  const trailForwardActions = createDrizzleTrailForwardActions({
    db: deps.db,
    documentAccess: deps.documentAccess,
    coordinator: liveCoordinator,
    model: runtime.model,
    codec: runtime.codec,
    durableProjectionSerializer: runtime.markdownDocuments,
  });

  return createCollabFacade({
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      primeReservedNamespaceIndex,
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
    authorityHeads: createDrizzleDocumentAuthorityHeads(deps.db),
    agentEdit: { agentEdit: () => agentEdit },
    reversal: turnReversal,
    documents: {
      ensureDocument: persistence.lifecycle.ensureDocument,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      writeDocument: runtime.markdownDocuments.writeDocument,
      editDocument: runtime.markdownDocuments.editDocument,
    },
    projections: {
      refreshDocumentProjection: projectionRefresher.refresh,
    },
    lineage,
    responses: responseFinalizer,
    checkpoints,
    attribution: createDocumentAttribution({
      latestUpdate: persistence.store.latestUpdate,
    }),
    trailForwardActions: {
      applyTrailForwardAction: trailForwardActions.apply,
    },
    branchPush: {
      recoverPendingLiveSettlements: branchPush.recoverPendingLiveSettlements,
      pushToLive: branchPush.pushToLive,
      pushSelectedToLive: branchPush.pushSelectedToLive,
      countUnpushedRowsForWork: workPushPolicy.countUnpushedRowsForWork,
      setWorkPushPolicy: branchPush.setWorkPushPolicy,
      markFailedResponseRollbackPending: branchReview.markFailedResponseRollbackPending,
    },
    branchPeers,
    drafts,
  });
}
