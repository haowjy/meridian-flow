/** Production dependency graph for the server collab domain. */

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
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} from "../../shared/drizzle-transaction.js";
import { lockWorksInIdOrder } from "../../shared/work-lifecycle-lock.js";
import { lockDocumentNamespaces } from "../context/adapters/context-fs/document-locations.js";
import {
  createDocumentLastAddress,
  createDocumentUriResolver,
} from "../context/document-uri-resolver.js";
import type { ContextCatalogMutationPort } from "../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../context/ports/document-arrivals.js";
import { createTreeReader } from "../context/tree/tree-view.js";
import type { FileAccess } from "../file-policy/index.js";
import type { NoticePort } from "../notices/index.js";
import { type EventSink, emitEvent } from "../observability/index.js";
import type { WorkProjectionMutation } from "../projects/index.js";
import type { ObjectRelease } from "../storage/index.js";
import {
  createAgentEditInvariantDiagnostic,
  createAgentEditObservabilityOptions,
  createBranchAgentEditDiagnostics,
  createBranchCoordinatorDiagnostics,
  createBranchPullDiagnostics,
  createDocumentProjectionDiagnostics,
  createDraftBranchAheadDiagnostics,
  createDraftReviewDiagnostics,
  createMarkdownSerializationAnomalyObserver,
  createResponseTransactionDiagnostics,
  createReversalNoticeDiagnostics,
  createSweepProjectionDiagnostics,
} from "./adapters/agent-edit-observability.js";
import {
  SILENT_POST_DURABILITY_NOTICES,
  SILENT_TURN_INVERSE_NOTICES,
  UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
} from "./adapters/declared-stubs.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
  createDrizzleWorkDraftPendingStore,
} from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleCollabLookups } from "./adapters/drizzle-collab-lookups.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import {
  createDrizzleAuthorityGenerationReader,
  createDrizzleDocumentAuthorityHeads,
} from "./adapters/drizzle-document-authority-head.js";
import {
  type AheadRegistrationRecovery,
  createDrizzleDocumentDerivationStore,
} from "./adapters/drizzle-document-derivations.js";
import { createDrizzleDraftCommands } from "./adapters/drizzle-draft-commands.js";
import {
  createDrizzleDraftDiscard,
  createDrizzleWorkDraftDisposal,
} from "./adapters/drizzle-draft-discard.js";
import { createDrizzleDraftTreeStep } from "./adapters/drizzle-draft-tree-step.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createDrizzleOfflineReconciliation } from "./adapters/drizzle-offline-reconciliation.js";
import {
  createDrizzlePendingSettlementStore,
  stageSettlementBatchWithinTx,
} from "./adapters/drizzle-pending-settlement.js";
import { createDrizzleReviewCut, readLiveDoc } from "./adapters/drizzle-review-cut.js";
import { createDrizzleTurnInverseService } from "./adapters/drizzle-turn-inverse.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
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
import { createBranchConcurrentJournalWatermarks } from "./domain/branch-agent-edit.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchCriticalSections } from "./domain/branch-critical-sections.js";
import { createBranchPullService } from "./domain/branch-pulls.js";
import { createBranchPushService } from "./domain/branch-push.js";
import { fullStateFingerprint } from "./domain/branch-push-transition.js";
import { createBranchReviewOperations } from "./domain/branch-review-operations.js";
import { createDocumentAttribution } from "./domain/document-attribution.js";
import { createDocumentCreationAggregate } from "./domain/document-creation.js";
import { createDocumentDerivationService } from "./domain/document-derivations.js";
import {
  scopeAgentEdit,
  scopeBranchPeer,
  scopeOfflineReconciliation,
  scopeResponseFinalizer,
} from "./domain/document-link-scope-doors.js";
import {
  createDocumentWriteHookRunner,
  createProjectionEffectsDocumentWriteHook,
} from "./domain/document-projection-refresher.js";
import { createDraftBranchAheadRegistration } from "./domain/draft-branch-ahead-registration.js";
import { createDraftBranchLeases } from "./domain/draft-branch-leases.js";
import { createDraftDiscard } from "./domain/draft-discard.js";
import { createDraftPublication } from "./domain/draft-publication.js";
import { createDraftReviewIdentity } from "./domain/draft-review-identity.js";
import { createDraftReviewItems } from "./domain/draft-review-items.js";
import { createDrafts } from "./domain/drafts.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import { createModelDocumentEdits } from "./domain/model-document-edits.js";
import { createPeerRetirement } from "./domain/peer-retirement.js";
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
import { createWorkDraftReviewService } from "./domain/work-draft-review-service.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import { createBranchThreadPeerAgentEditCore } from "./thread-peer-composition.js";

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
};

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const persistence = createDrizzleCollabPersistence(deps.db);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => runInDrizzleTransaction(deps.db, operation),
    ensureDocument: persistence.lifecycle.ensureDocument,
    onArrival: (id) => deps.arrivals?.settle([id]) ?? Promise.resolve(0),
  });
  const hocuspocusBinding = createHocuspocusBinding(deps.eventSink);
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: hocuspocusBinding.require,
    journal: persistence.journal,
  });
  const criticalSections = createBranchCriticalSections();
  const workDrafts = createDrafts({
    store: createDrizzleDraftStore(deps.db),
    boundary: createDrizzleDraftWriteBoundary(deps.db),
  });
  const branches = createDrizzleBranchStore(deps.db, {
    live: {
      journal: persistence.journal,
      lifecycle: persistence.lifecycle,
    },
    workProjection: deps.workProjectionMutation,
    drafts: workDrafts,
  });
  const branchJournal = createDrizzleBranchJournalReadStore(deps.db);
  const branchCoordinator = createBranchCoordinator({
    journalReads: branchJournal,
    store: branches,
    criticalSections,
    onBranchUpdate: hocuspocusBinding.publishBranchUpdate,
    onBranchReset: ({ branchId }) => hocuspocusBinding.closeBranch(branchId),
    diagnostics: createBranchCoordinatorDiagnostics(deps.eventSink),
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
    branches,
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
    lifecycle: documentCreation,
    initialDocumentSeeds: persistence.lifecycle,
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

  const workDraftPendingStore = createDrizzleWorkDraftPendingStore(deps.db);
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
      // Apply's tree work publishes with the text it applies (contract §11.2).
      steps: [
        createDrizzleDraftTreeStep(deps.db, {
          drafts: workDrafts,
          branches,
          coordinator: branchCoordinator,
          liveDoc: (documentId) => readLiveDoc(persistence.journal, documentId),
          ...(deps.arrivals ? { arrivals: deps.arrivals } : {}),
          workProjection: deps.workProjectionMutation,
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
    branchStore: branches,
    criticalSections,
    journalReadStore: branchJournal,
    commitStore: pushCommits,
    settlementStore: pendingSettlements,
    branchCoordinator,
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
  const branchReview = createBranchReviewOperations({
    branchStore: branches,
    journalReadStore: branchJournal,
    commitStore: pushCommits,
    branchCoordinator,
    journal: persistence.journal,
    criticalSections,
  });

  const agentEdit = scopeAgentEdit(
    createBranchThreadPeerAgentEditCore({
      documentEdits: modelDocumentEdits,
      drafts: workDrafts,
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
      lifecycle: persistence.lifecycle,
      branches,
      branchCoordinator,
      criticalSections,
      branchPulls,
      branchJournal,
      concurrentJournalWatermarks,
      diagnostics: createBranchAgentEditDiagnostics(deps.eventSink),
      afterCommit: runAfterDrizzleCommit,
      enlistResponseParticipant,
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      aheadRefs: deps.aheadRefs,
      semanticProvenance: runtime.semanticProvenance,
      observability,
      commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(deps.db, operation),
      attemptScope: (operation) => runInDrizzleSavepoint(deps.db, operation),
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
  const draftBranchAheads = createDraftBranchAheadRegistration({
    branches: branchCoordinator,
    drafts: workDrafts,
    registrar: deps.aheadRefs,
    outsideTransaction: runOutsideDrizzleTransaction,
    diagnostics: createDraftBranchAheadDiagnostics(deps.eventSink),
    // The writer's own links follow the pull cadence: soon after typing, never per keystroke.
    ...(deps.livePullDebounceMs === undefined ? {} : { debounceMs: deps.livePullDebounceMs }),
  });
  const authorityGeneration = createDrizzleAuthorityGenerationReader(deps.db);
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    backgroundTasks: deps.backgroundTasks,
    journal: persistence.journal,
    branchStore: branches,
    branchCoordinator,
    hocuspocus: hocuspocusBinding.current,
    eventSink: deps.eventSink,
    metaForOrigin,
    afterCallerCommit: (callback) => {
      runAfterDrizzleCommit(callback);
    },
    readAuthorityHeadGeneration: authorityGeneration,
    emitAgentEditInvariantViolation: createAgentEditInvariantDiagnostic(deps.eventSink),
    onLiveUpdatePersisted: (documentId) => {
      branchPulls.scheduleLivePull(documentId);
      derivations.schedule(documentId);
    },
    onBranchWriterUpdateAdmitted: (branchId) => draftBranchAheads.schedule(branchId),
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
    branches,
    coordinator: liveCoordinator,
    branchCoordinator,
    criticalSections,
    resolveDocumentUri: documentUriResolver,
    refreshDocument: (documentId) => projectionRefresher.refresh({ documentId }),
    flushLivePull: branchPulls.flushLivePull,
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
  const reviewItems = createDraftReviewItems({
    tree: createTreeReader(deps.db),
    branches: (draftId, documentIds) =>
      workDraftPendingStore.listDraftBranchEvidence(draftId, documentIds),
    creators: (draftId, documentIds) => workDraftPendingStore.listCreators(draftId, documentIds),
    settling: (draftId) => workDraftPendingStore.listSettling(draftId),
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
  const publication = createDraftPublication({
    drafts: workDrafts,
    reviewItems,
    push: branchPush,
  });
  const draftLeases = createDraftBranchLeases({ branches, criticalSections });
  const discardStore = createDrizzleDraftDiscard(deps.db, {
    drafts: workDrafts,
    branches,
    coordinator: branchCoordinator,
    workProjection: deps.workProjectionMutation,
    catalog: deps.catalogMutations,
  });
  // Exactly the branches a committed change closed or deleted: their rooms and threads.
  const retirePeers = createPeerRetirement({
    closeBranchRoom: hocuspocusPersistence.closeHocuspocusBranchRoom,
    agentEdit,
  });
  const discard = createDraftDiscard({
    drafts: workDrafts,
    draftLeases,
    criticalSections,
    liveCoordinator,
    store: discardStore,
    retire: retirePeers,
    releaseObjects: (storageUrls) => deps.objects?.storageUrls(storageUrls) ?? Promise.resolve(),
  });
  const identity = createDraftReviewIdentity({ drafts: workDrafts, reviewItems });
  const drafts = createWorkDraftReviewService({
    diagnostics: createDraftReviewDiagnostics(deps.eventSink),
    drafts: workDrafts,
    reviewItems,
    identity,
    publication,
    discard,
    branchReview,
    commands: createDrizzleDraftCommands(deps.db),
    model: runtime.model,
    resolveThreadTitles: lookups.resolveThreadTitles,
    pending: workDraftPendingStore,
    readReviewCut: createDrizzleReviewCut({
      db: deps.db,
      journal: persistence.journal,
      branches,
      rows: branchJournal,
      links: deps.links,
      identity,
      resolveThreadTitles: lookups.resolveThreadTitles,
    }),
  });
  const branchPeers = scopeBranchPeer(
    createEffectiveDocumentReader({
      branches,
      branchCoordinator,
      branchPulls,
      liveCoordinator,
      agentEdit,
      documents: runtime.markdownDocuments,
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      retirePeers,
      deferUntilCommit: deferUntilDrizzleCommit,
      drafts: workDrafts,
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
        branchPulls.cancelScheduledPulls();
        draftBranchAheads.cancelScheduled();
      },
    },
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
      withLiveDocument: runtime.markdownDocuments.withLiveDocument,
      writeDocumentHeld: runtime.markdownDocuments.writeDocumentHeld,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
      bindStatic: runtime.linkBinder.bindStatic,
    },
    projections: {
      documentDerivations: derivations,
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
      countPendingByWorkIds: workDraftPendingStore.countPendingByWorkIds,
    },
    branchPeers,
    drafts,
    draftResolver: {
      drafts: workDrafts,
      draftLinks: draftBranchAheads,
      draftLeases,
      workDraftDisposal: createDrizzleWorkDraftDisposal(deps.db, {
        drafts: workDrafts,
        criticalSections,
        catalog: deps.catalogMutations,
      }),
    },
    documentCreation,
  });
}
