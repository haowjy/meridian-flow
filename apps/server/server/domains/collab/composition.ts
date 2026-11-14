/** Production dependency graph for the server collab domain. */

import type { BranchId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentDrafts } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} from "../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../shared/work-lifecycle-lock.js";
import {
  createDocumentLastAddress,
  createDocumentUriResolver,
} from "../context/document-uri-resolver.js";
import type { DocumentArrivals } from "../context/ports/document-arrivals.js";
import type { DocumentRemovals } from "../context/ports/document-removal.js";
import type { TreeListStore } from "../context/ports/tree-list-store.js";
import { createTreeReader } from "../context/tree/tree-view.js";
import type { FileAccess } from "../file-policy/index.js";
import type { NoticePort } from "../notices/index.js";
import { type EventSink, emitEvent } from "../observability/index.js";
import type { WorkProjectionMutation } from "../projects/index.js";
import {
  createAgentEditInvariantDiagnostic,
  createAgentEditObservabilityOptions,
  createAppendCommittedEvent,
  createDocumentProjectionDiagnostics,
  createDraftAheadDiagnostics,
  createDraftProjectionDiagnostics,
  createDraftPullDiagnostics,
  createMarkdownSerializationAnomalyObserver,
  createReversalNoticeDiagnostics,
  createRewriteCommittedEvent,
  createRoomDeliveryDiagnostics,
  createWriterFrameDiagnostics,
} from "./adapters/agent-edit-observability.js";
import {
  SILENT_TURN_INVERSE_NOTICES,
  UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
} from "./adapters/declared-stubs.js";
import { createDrizzleApplyClick, measureApplyAppend } from "./adapters/drizzle-apply-click.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import { createDrizzleBlockText } from "./adapters/drizzle-block-text.js";
import {
  createDrizzleBranchDiscard,
  createDrizzleWorkBranchDisposal,
} from "./adapters/drizzle-branch-discard.js";
import { createDrizzleBranchTreeActors } from "./adapters/drizzle-branch-tree-actors.js";
import {
  branchFolderRevisions,
  createDrizzleBranchTreeState,
} from "./adapters/drizzle-branch-tree-state.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleCollabLookups } from "./adapters/drizzle-collab-lookups.js";
import { createDrizzleCommandDocuments } from "./adapters/drizzle-command-documents.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import { createDrizzleAuthorityGenerationReader } from "./adapters/drizzle-document-authority-head.js";
import { createDrizzleDocumentCommands } from "./adapters/drizzle-document-commands.js";
import {
  type AheadRegistrationRecovery,
  createDrizzleDocumentDerivationStore,
} from "./adapters/drizzle-document-derivations.js";
import { createDrizzleDocumentPurgeDisposal } from "./adapters/drizzle-document-purge-disposal.js";
import { type DraftClose, draftsStillClosedBy } from "./adapters/drizzle-draft-close.js";
import { createDrizzleDraftDispositionStore } from "./adapters/drizzle-draft-disposition.js";
import { createDrizzleDraftReplayJournalReads } from "./adapters/drizzle-draft-journal-reads.js";
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence, enterLiveWriteSeam } from "./adapters/drizzle-journal.js";
import { createDrizzleModelEdits } from "./adapters/drizzle-model-edits.js";
import { createDrizzleModelEvidence } from "./adapters/drizzle-model-evidence.js";
import { createDrizzleTreeHistory } from "./adapters/drizzle-tree-history.js";
import { createDrizzleTurnInverseService } from "./adapters/drizzle-turn-inverse.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleUndoDiscard } from "./adapters/drizzle-undo-discard.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import { createHocuspocusBinding } from "./adapters/hocuspocus-binding.js";
import {
  createDeferredLiveProjectionCoordinator,
  createHocuspocusCoordinator,
} from "./adapters/hocuspocus-coordinator.js";
import { createCheckpointService } from "./checkpoints.js";
import { createCollabFacade } from "./collab-facade.js";
import type { CollabDomain } from "./contracts.js";
import { createAgentEditRouter } from "./domain/agent-edit-router.js";
import { createAgentEditRuntime, metaForOrigin } from "./domain/agent-edit-runtime.js";
import { createApplyClickService } from "./domain/apply-click.js";
import { createBranchDiscard } from "./domain/branch-discard.js";
import { createBranchReviewIdentity } from "./domain/branch-review-identity.js";
import { createBranchReviewItems } from "./domain/branch-review-items.js";
import { createBranches } from "./domain/branches.js";
import { createDocumentAttribution } from "./domain/document-attribution.js";
import { createDocumentCreationAggregate } from "./domain/document-creation.js";
import {
  createBlockDeriver,
  createDocumentDerivationService,
} from "./domain/document-derivations.js";
import {
  scopeAgentEdit,
  scopeDraftPeer,
  scopeModelEditWrite,
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
import { createModelEditWriter } from "./domain/model-edit-write.js";
import { liveRoom } from "./domain/observation-rooms.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import { primeReservedNamespaceIndex } from "./domain/provenance.js";
import { createReversalNoticePort } from "./domain/reversal-notices.js";
import { createTurnLiveLineageReadModel } from "./domain/turn-live-lineage.js";
import {
  createTurnReversalService,
  type ThreadContextReversalResolver,
} from "./domain/turn-reversal-service.js";
import { createUndoDiscardService } from "./domain/undo-discard.js";
import { createWorkBranchReviewService } from "./domain/work-branch-review-service.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import { closeRemovedDocumentRooms } from "./hocuspocus-rooms.js";
import { createThreadCores } from "./thread-cores.js";

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
  fileAccess: Pick<
    FileAccess,
    "authorize" | "authorizeAt" | "confirmEdit" | "destinationAvailability"
  >;
  /** How long a live AI write waits before merging into Work drafts; tests shorten it. */
  livePullDebounceMs?: number;
  /** Ahead-ref settlement at tracked creates and Apply completions (contract §9.3–9.4). */
  arrivals?: DocumentArrivals;
  /** Registers client-minted ahead refs after certified derives, and recovers failures (§11.3). */
  aheadRegistrations?: AheadRegistrationRecovery;
  /** The one draft close; this domain binds its retirement once its rooms and cores exist. */
  draftClose: DraftClose;
  /** The project tree's lists: Apply and Discard settle a Work's records through `submit`. */
  treeLists: TreeListStore;
  /** What took a document out of live (its Trash entry), for a pin or a room that lost it. */
  removals: DocumentRemovals;
};

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const persistence = createDrizzleCollabPersistence(deps.db);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => runInDrizzleTransaction(deps.db, operation),
    onArrivals: (ids) => deps.arrivals?.settle(ids) ?? Promise.resolve(0),
  });
  const hocuspocusBinding = createHocuspocusBinding(deps.eventSink);
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: hocuspocusBinding.require,
    journal: persistence.journal,
    transactions: { inTransaction: isInDrizzleTransaction, afterCommit: deferUntilDrizzleCommit },
    diagnostics: createRoomDeliveryDiagnostics(deps.eventSink),
  });
  // Every bounded draft-store attempt's rollback boundary.
  const attemptScope: AttemptScope = (operation) => runInDrizzleSavepoint(deps.db, operation);
  // Removal records, read by the tools that answer a call on a removed document.
  const removalRecords = deps.removals;
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
    deriveBlocks: createBlockDeriver({
      runtime: () => runtime,
      resolveFiletype: lookups.resolveDocumentFiletype,
    }),
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
  });
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

  const readAuthorityGeneration = createDrizzleAuthorityGenerationReader(deps.db);
  const workBranchPendingStore = createDrizzleWorkBranchPendingStore(deps.db);
  const threadCore = createThreadCores({
    documentEdits: modelDocumentEdits,
    journal: persistence.journal,
    drafts,
    draftCoordinator,
    draftPulls,
    draftJournal: replayJournal,
    model: runtime.model,
    codec: runtime.codec,
    links: deps.links,
    aheadRefs: deps.aheadRefs,
    semanticProvenance: runtime.semanticProvenance,
    observability,
  });
  const agentEdit = scopeAgentEdit(
    createAgentEditRouter({
      branches: workBranches,
      drafts,
      liveUtilityCore: runtime.liveUtilityCore,
      threadCore,
    }),
    deps.links,
  );

  const modelEvidence = createDrizzleModelEvidence(deps.db);
  const modelEditWrite = createModelEditWriter({
    evidence: modelEvidence,
    liveCore: runtime.liveUtilityCore,
    threadCore,
    branches: workBranches,
    fileAccess: deps.fileAccess,
    enterLiveSeam: (documentId) => enterLiveWriteSeam(deps.db, documentId),
    enterDraftSeam: async () => {
      await lockSeamWorks(deps.db, []);
    },
    ensureWorkDraft: ({ documentId, branchId }) =>
      drafts.ensureLiveDocumentDraft({ documentId, branchId: branchId as BranchId }),
    lockDraft: async (draftId) => {
      await currentDrizzleDb(deps.db)
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, draftId))
        .for("update");
    },
    roomsOf: async (documentId) => ({
      liveRoom: liveRoom(documentId, await readAuthorityGeneration(documentId)),
      drafts: await drafts.listWorkDraftStates(documentId),
    }),
    afterLiveCommit: (documentId) =>
      deferUntilDrizzleCommit(() => draftPulls.scheduleLivePull(documentId)),
  });
  const modelEdits = createDrizzleModelEdits(
    deps.db,
    {
      write: scopeModelEditWrite(modelEditWrite, deps.links),
      catchUp: (documentId) => draftPulls.flushLivePull(documentId),
    },
    modelEvidence,
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
    readAuthorityHeadGeneration: readAuthorityGeneration,
    emitAgentEditInvariantViolation: createAgentEditInvariantDiagnostic(deps.eventSink),
    onLiveUpdatePersisted: (documentId) => {
      draftPulls.scheduleLivePull(documentId);
      derivations.schedule(documentId);
    },
    onDraftWriterUpdateAdmitted: (draftId) => draftAheads.schedule(draftId),
  });

  const treeHistory = createDrizzleTreeHistory(
    deps.db,
    persistence.journal,
    (threadId, documentId) => turnInverse.modelStack(documentId as DocumentId, threadId),
  );
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
    removals: removalRecords,
    fileAccess: deps.fileAccess,
    treeLists: deps.treeLists,
  });
  const treeReader = createTreeReader(deps.db);
  const branchTreeState = createDrizzleBranchTreeState(deps.db, treeReader);
  const reviewItems = createBranchReviewItems({
    tree: branchTreeState,
    drafts: (branchId, documentIds) =>
      workBranchPendingStore.listBranchDraftMetadata(branchId, documentIds),
    pendingThreadIds: workBranchPendingStore.pendingThreadIds,
    treeActors: createDrizzleBranchTreeActors(deps.db, deps.treeLists),
  });
  // Exactly what each committed transaction ended: its closed drafts' rooms.
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
      stillClosedBy: (drafts) => draftsStillClosedBy(currentDrizzleDb(deps.db), drafts),
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
    close: deps.draftClose,
    branches: workBranches,
    workProjection: deps.workProjectionMutation,
    treeLists: deps.treeLists,
  });
  const discard = createBranchDiscard({
    branches: workBranches,
    store: discardStore,
    holdRetirement: deps.draftClose.holdRetirement,
  });
  const identity = createBranchReviewIdentity({ branches: workBranches, reviewItems });
  const commands = createDrizzleDocumentCommands(deps.db);
  const applyCommands = createApplyClickService({
    commands,
    evidence: createDrizzleDraftDispositionStore(deps.db),
    store: createDrizzleApplyClick(deps.db, {
      workProjection: deps.workProjectionMutation,
      branches: workBranches,
      coordinator: draftCoordinator,
      live: persistence.journal,
      liveCoordinator,
      arrivals: deps.arrivals,
      treeLists: deps.treeLists,
      tree: treeReader,
      branchTree: branchTreeState,
      close: deps.draftClose,
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
  const undoDiscard = createUndoDiscardService({
    commands,
    store: createDrizzleUndoDiscard(deps.db, {
      workProjection: deps.workProjectionMutation,
      branches: workBranches,
      treeLists: deps.treeLists,
      close: deps.draftClose,
    }),
  });
  const branches = createWorkBranchReviewService({
    commandDocuments: createDrizzleCommandDocuments(deps.db, { treeLists: deps.treeLists }),
    apply: applyCommands.apply,
    unapplyClick: applyCommands.unapply,
    undoDiscard,
    branches: workBranches,
    reviewItems,
    identity,
    discard,
    commands,
    resolveThreadTitles: lookups.resolveThreadTitles,
    folderRevisions: (branchId) => branchFolderRevisions(deps.db, branchId),
    pending: workBranchPendingStore,
  });
  const draftPeers = scopeDraftPeer(
    createEffectiveDocumentReader({
      drafts,
      draftCoordinator,
      blockText: createDrizzleBlockText(deps.db),
      draftPulls,
      agentEdit,
      documents: runtime.markdownDocuments,
      model: runtime.model,
      codec: runtime.codec,
      links: deps.links,
      branches: workBranches,
      resolveFiletype: lookups.resolveDocumentFiletype,
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
    commands,
    threadContext:
      deps.threadContext ?? UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS.threadContext,
  });
  return createCollabFacade({
    importBinder: runtime.importBinder,
    lifecycle: {
      dispose: async () => {
        await Promise.all([draftAheads.shutdown(), draftPulls.shutdown(), draftEffects.dispose()]);
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
        const removal = (await removalRecords.lookup([documentId])).get(documentId);
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
      modelEdits: () => modelEdits,
      modelEvidence: () => modelEvidence,
      treeHistory: () => treeHistory,
    },
    reversal: turnReversal,
    documents: {
      readForExport: runtime.markdownDocuments.readForExport,
      ensureDocumentAuthority: runtime.markdownDocuments.ensureDocumentAuthority,
      readAsMarkdown: runtime.markdownDocuments.readAsMarkdown,
      readFrozenMarkdown: runtime.markdownDocuments.readFrozenMarkdown,
      readVersionedMarkdown: runtime.markdownDocuments.readVersionedMarkdown,
      seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      discardUnbornDocuments: persistence.seeds.discardUnbornDocuments,
      encodeSeed: runtime.markdownDocuments.encodeSeed,
      installSeeds: runtime.markdownDocuments.installSeeds,
      writeDocument: runtime.markdownDocuments.writeDocument,
      withLiveDocument: runtime.markdownDocuments.withLiveDocument,
      writeDocumentHeld: runtime.markdownDocuments.writeDocumentHeld,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
      bindCopiedBlocks: runtime.linkBinder.bindCopiedBlocks,
      bindStatic: runtime.linkBinder.bindStatic,
    },
    projections: {
      documentDerivations: derivations,
      refreshDocumentProjection: projectionRefresher.refresh,
      draftEffects: { sweep: draftEffects.sweep, flush: draftEffects.flush },
    },
    lineage,
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
        close: deps.draftClose,
        branches: workBranches,
        treeLists: deps.treeLists,
      }),
      documentPurgeDraftDisposal: createDrizzleDocumentPurgeDisposal(deps.db, {
        close: deps.draftClose,
      }),
    },
    documentCreation,
  });
}
