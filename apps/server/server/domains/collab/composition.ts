/** Production dependency graph for the server collab domain. */

import type { BranchId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches as branchRows, branchTreeNodes } from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { lockDocumentMutation } from "../../shared/document-mutation-lock.js";
import { ownerOfColumns } from "../../shared/draft-owner.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  runOutsideDrizzleTransaction,
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
  createAgentEditObservabilityOptions,
  createDocumentProjectionDiagnostics,
  createMarkdownSerializationAnomalyObserver,
  createReversalNoticeDiagnostics,
  createRoomDeliveryDiagnostics,
} from "./adapters/agent-edit-observability.js";
import {
  SILENT_TURN_INVERSE_NOTICES,
  UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
} from "./adapters/declared-stubs.js";
import { createDrizzleAuthorityGenerationReplacement } from "./adapters/drizzle-authority-generation-replacement.js";
import { createDrizzleBlockText } from "./adapters/drizzle-block-text.js";
import { createDrizzleBranchTreeActors } from "./adapters/drizzle-branch-tree-actors.js";
import { treeCutOf } from "./adapters/drizzle-branch-tree-lists.js";
import {
  branchFolderIds,
  createDrizzleBranchTreeState,
} from "./adapters/drizzle-branch-tree-state.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleCollabLookups } from "./adapters/drizzle-collab-lookups.js";
import { createDrizzleDiscardPurge } from "./adapters/drizzle-discard-purge.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import { createDrizzleAuthorityGenerationReader } from "./adapters/drizzle-document-authority-head.js";
import { createDrizzleDocumentCommands } from "./adapters/drizzle-document-commands.js";
import {
  type AheadRegistrationRecovery,
  createDrizzleDocumentDerivationStore,
} from "./adapters/drizzle-document-derivations.js";
import { createDrizzleDocumentPurgeDisposal } from "./adapters/drizzle-document-purge-disposal.js";
import { createDrizzleCollabPersistence, enterLiveWriteSeam } from "./adapters/drizzle-journal.js";
import { createDrizzleModelEdits } from "./adapters/drizzle-model-edits.js";
import { createDrizzleModelEvidence } from "./adapters/drizzle-model-evidence.js";
import { createDrizzlePress } from "./adapters/drizzle-press.js";
import { createDrizzleReversalLocks } from "./adapters/drizzle-reversal-locks.js";
import { createDrizzleTreeHistory } from "./adapters/drizzle-tree-history.js";
import { createDrizzleTurnInverseService } from "./adapters/drizzle-turn-inverse.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import { createDrizzleWorkCreates } from "./adapters/drizzle-work-creates.js";
import { createDrizzleWorkBranchDisposal } from "./adapters/drizzle-work-disposal.js";
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
import { createBranchReviewIdentity } from "./domain/branch-review-identity.js";
import { createBranchReviewItems } from "./domain/branch-review-items.js";
import { createBranches } from "./domain/branches.js";
import { createDocumentAttribution } from "./domain/document-attribution.js";
import { createDocumentCreationAggregate } from "./domain/document-creation.js";
import { createCutReader, createDocumentDerivationService } from "./domain/document-derivations.js";
import {
  scopeAgentEdit,
  scopeDraftPeer,
  scopeModelEditWrite,
} from "./domain/document-link-scope-doors.js";
import {
  createDocumentWriteHookRunner,
  createProjectionEffectsDocumentWriteHook,
} from "./domain/document-projection-refresher.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import { createModelDocumentEdits } from "./domain/model-document-edits.js";
import { createModelEditRead, createModelEditWriter } from "./domain/model-edit-write.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import { createReversalNoticePort } from "./domain/reversal-notices.js";
import { createSuggestionTurnUndo } from "./domain/suggestion-turn-undo.js";
import { createTurnLiveLineageReadModel } from "./domain/turn-live-lineage.js";
import {
  createTurnReversalService,
  type ThreadContextReversalResolver,
} from "./domain/turn-reversal-service.js";
import { createWorkBranchReviewService } from "./domain/work-branch-review-service.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import { closeRemovedDocumentRooms } from "./hocuspocus-rooms.js";

export type { DocumentWriteHook } from "./contracts.js";

type CollabDomainDeps = {
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
  /** Ahead-ref settlement at tracked creates and Apply completions (contract §9.3–9.4). */
  arrivals?: DocumentArrivals;
  /** Registers client-minted ahead refs after certified derives, and recovers failures (§11.3). */
  aheadRegistrations?: AheadRegistrationRecovery;
  /** The project tree's lists: Apply and Discard settle a Work's records through `submit`. */
  treeLists: TreeListStore;
  /** What took a document out of live (its Trash entry), for a pin or a room that lost it. */
  removals: DocumentRemovals;
  /** A live document's text changed, through its room or a direct write (the AI, Apply). */
  liveTextHints?: {
    hint(documentId: DocumentId): void;
    /** Cancels what is pending; the composition's `dispose` calls it. */
    stop(): void;
  };
};

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  /**
   * Live's text advanced and committed: through a room, a direct write, or a generation replacement.
   * The one notice every consumer of Live's text hangs on; each coalesces it on its own cadence.
   */
  const liveAdvanced = (documentId: DocumentId) => {
    derivations.schedule(documentId);
    deps.liveTextHints?.hint(documentId);
  };
  const persistence = createDrizzleCollabPersistence(deps.db, liveAdvanced);
  const documentCreation = createDocumentCreationAggregate({
    atomic: (operation) => runInDrizzleTransaction(deps.db, operation),
    onArrivals: (ids) => deps.arrivals?.settle(ids) ?? Promise.resolve(0),
  });
  const hocuspocusBinding = createHocuspocusBinding();
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: hocuspocusBinding.require,
    journal: persistence.journal,
    transactions: { inTransaction: isInDrizzleTransaction, afterCommit: deferUntilDrizzleCommit },
    diagnostics: createRoomDeliveryDiagnostics(deps.eventSink),
  });
  // Removal records, read by the tools that answer a call on a removed document.
  const removalRecords = deps.removals;
  const workBranches = createBranches({
    store: createDrizzleBranchStore(deps.db),
    boundary: createDrizzleBranchWriteBoundary(deps.db, deps.workProjectionMutation),
  });
  const documentUriResolver = createDocumentUriResolver(deps.db);
  const documentLastAddress = createDocumentLastAddress(deps.db);
  const resolveLastDocumentUri = async (documentId: string, branchId?: BranchId) =>
    (await documentLastAddress(documentId as DocumentId, branchId))?.uri ?? null;
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
    deps.workProjectionMutation,
  );
  const derivations = createDocumentDerivationService({
    store: derivationStore,
    readCut: createCutReader({
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
  const projectionHook = createProjectionEffectsDocumentWriteHook(
    projectionEffects,
    derivations.derive,
  );
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: projectionHook,
    diagnostics: projectionDiagnostics,
  });
  const observability = createAgentEditObservabilityOptions({
    eventSink: deps.eventSink,
  });
  const modelDocumentEdits = createModelDocumentEdits({ service: () => turnInverse });
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
    lockDocument: (documentId) => lockDocumentMutation(currentDrizzleDb(deps.db), documentId),
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
  const agentEditRouter = createAgentEditRouter({
    liveUtilityCore: runtime.liveUtilityCore,
    workView: runtime.workView,
    branches: workBranches,
  });
  const agentEdit = scopeAgentEdit(agentEditRouter, deps.links);
  const modelEditRead = createModelEditRead(agentEdit.read);

  const modelEvidence = createDrizzleModelEvidence(deps.db);
  const modelEditWrite = createModelEditWriter({
    liveCore: runtime.liveUtilityCore,
    workView: runtime.workView,
    branches: workBranches,
    fileAccess: deps.fileAccess,
    enterLiveSeam: (documentId) => enterLiveWriteSeam(deps.db, documentId),
    enterDraftSeam: async () => {
      await lockSeamWorks(deps.db, []);
    },
    existsOnlyInWork: async (documentId, owner) => {
      const branch = await workBranches.activeForOwner(owner);
      if (!branch) return false;
      const [row] = await currentDrizzleDb(deps.db)
        .select({ id: branchTreeNodes.id })
        .from(branchTreeNodes)
        .where(
          and(
            eq(branchTreeNodes.branchId, branch.id),
            eq(branchTreeNodes.id, documentId),
            eq(branchTreeNodes.existsOnlyInDraft, true),
          ),
        );
      return row !== undefined;
    },
  });
  const modelEdits = createDrizzleModelEdits(
    deps.db,
    { write: scopeModelEditWrite(modelEditWrite, deps.links), read: modelEditRead },
    modelEvidence,
  );

  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal: persistence.journal,
    hocuspocus: hocuspocusBinding.current,
    eventSink: deps.eventSink,
    metaForOrigin,
    afterCallerCommit: (callback) => {
      runAfterDrizzleCommit(callback);
    },
    readAuthorityHeadGeneration: readAuthorityGeneration,
  });

  const treeHistory = createDrizzleTreeHistory(
    deps.db,
    persistence.journal,
    (threadId, documentId) => turnInverse.modelStack(documentId as DocumentId, threadId),
  );
  const turnInverse = createDrizzleTurnInverseService({
    db: deps.db,
    journal: persistence.journal,
    coordinator: liveCoordinator,
    resolveDocumentUri: documentUriResolver,
    resolveLastDocumentUri,
    refreshDocument: (documentId) => projectionRefresher.refresh({ documentId }),
    notices: deps.notices
      ? createReversalNoticePort({
          notices: deps.notices,
          resolveLastDocumentUri,
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
    text: (branchId, documentIds) =>
      workBranchPendingStore.listBranchTextChanges(branchId, documentIds),
    treeActors: createDrizzleBranchTreeActors(deps.db, deps.treeLists),
  });
  const identity = createBranchReviewIdentity({ branches: workBranches, reviewItems });
  const commands = createDrizzleDocumentCommands(deps.db);
  const discardPurge = createDrizzleDiscardPurge(deps.db, {
    workProjection: deps.workProjectionMutation,
    ...(deps.eventSink ? { eventSink: deps.eventSink } : {}),
  });
  const branches = createWorkBranchReviewService({
    purgeDiscards: () => discardPurge.purge(),
    branches: workBranches,
    reviewItems,
    identity,
    commands,
    resolveThreadTitles: lookups.resolveThreadTitles,
    folderIds: (branchId) => branchFolderIds(deps.db, branchId),
    treeCut: (branchId) => treeCutOf(deps.db, deps.treeLists, branchId),
    pending: workBranchPendingStore,
  });
  const draftPeers = scopeDraftPeer(
    createEffectiveDocumentReader({
      blockText: createDrizzleBlockText(deps.db),
      agentEdit,
      documents: runtime.markdownDocuments,
      model: runtime.model,
      workView: runtime.workView,
      codec: runtime.codec,
      links: deps.links,
      branches: workBranches,
      resolveFiletype: lookups.resolveDocumentFiletype,
    }),
    deps.links,
    createDrizzleWorkCreates(deps.db, { documents: runtime.markdownDocuments }),
  );

  const replaceAuthorityGeneration = createDrizzleAuthorityGenerationReplacement({
    db: deps.db,
    coordinator: liveCoordinator,
    checkpoints: persistence.store,
    disconnectGeneration: hocuspocusPersistence.disconnectLiveGeneration,
    onReplaced: liveAdvanced,
  });
  const checkpoints = createCheckpointService({
    coordinator: liveCoordinator,
    store: persistence.store,
    journal: persistence.journal,
    markdownDocuments: runtime.markdownDocuments,
    replaceAuthorityGeneration,
  });
  const lineageStore = createDrizzleTurnLiveLineageStore(deps.db);
  // A card's Undo rejects the turn's suggestions; the Live inverse takes the rest.
  const suggestionTurnUndo = createSuggestionTurnUndo({
    schema: buildDocumentSchema(),
    listTurnDocuments: lineageStore.listEditedDocumentIdsForTurn,
    resolveDocumentUri: documentUriResolver,
    changeLiveDocument: runtime.markdownDocuments.changeLiveDocument,
    reverseLiveTurn: turnInverse.reverseTurn,
    fileAccess: deps.fileAccess,
    enterLiveSeam: (documentId) => enterLiveWriteSeam(deps.db, documentId),
    confirmGrants: async () => {
      await lockSeamWorks(deps.db, []);
    },
    withLiveDocument: runtime.markdownDocuments.withLiveDocument,
    liveTurnChip: turnInverse.getDocumentAndTreeChip,
  });
  const turnUndo = {
    ...turnInverse,
    reverseTurn: suggestionTurnUndo.reverseTurn,
    getDocumentAndTreeChip: suggestionTurnUndo.chip,
  };
  const lineage = createTurnLiveLineageReadModel({
    store: lineageStore,
    receiptStore: turnUndo,
    resolveDocumentUri: documentUriResolver,
    resolveLastDocumentUri,
  });
  const turnReversal = createTurnReversalService({
    turnInverse: turnUndo,
    lockOwners: createDrizzleReversalLocks(deps.db),
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
        deps.liveTextHints?.stop();
        liveCoordinator.stop();
      },
    },
    transport: {
      bindHocuspocus: hocuspocusBinding.bind,
      headSchemaVersion: persistence.journal.headSchemaVersion,
      loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,
      admitLiveWriterUpdate: hocuspocusPersistence.admitLiveWriterUpdate,
      currentLiveGeneration: hocuspocusPersistence.currentLiveGeneration,
      async workOnlyOwners(documentId) {
        const rows = await currentDrizzleDb(deps.db)
          .select({
            projectId: branchRows.projectId,
            workId: branchRows.originWorkId,
            rootThreadId: branchRows.originRootThreadId,
          })
          .from(branchTreeNodes)
          .innerJoin(branchRows, eq(branchRows.id, branchTreeNodes.branchId))
          .where(
            and(
              eq(branchTreeNodes.id, documentId),
              eq(branchTreeNodes.existsOnlyInDraft, true),
              eq(branchRows.status, "active"),
            ),
          );
        return rows.flatMap((row) => ownerOfColumns(row) ?? []);
      },
      async roomRemoval(documentId) {
        const removal = (await removalRecords.lookup([documentId])).get(documentId);
        return removal ? { documentId, removal } : null;
      },
      validateHocuspocusDocument: hocuspocusPersistence.validateHocuspocusDocument,
      storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,
      drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,
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
      mergeCodeText: runtime.markdownDocuments.mergeCodeText,
      withLiveDocument: runtime.markdownDocuments.withLiveDocument,
      writeDocumentHeld: runtime.markdownDocuments.writeDocumentHeld,
      bindMarkdown: runtime.linkBinder.bindMarkdown,
      bindCopiedBlocks: runtime.linkBinder.bindCopiedBlocks,
      bindStatic: runtime.linkBinder.bindStatic,
    },
    projections: {
      documentDerivations: derivations,
      refreshDocumentProjection: projectionRefresher.refresh,
    },
    lineage,
    checkpoints,
    attribution: createDocumentAttribution({ latestUpdate: persistence.store.latestUpdate }),
    draftPeers,
    branches: {
      ...branches,
      presses: createDrizzlePress(deps.db, {
        workProjection: deps.workProjectionMutation,
        branches: workBranches,
        live: persistence.journal,
        liveCoordinator,
        arrivals: deps.arrivals,
        treeLists: deps.treeLists,
        tree: treeReader,
        onCommitted: async (documentId) => {
          await runDocumentWriteHook({ documentId }, "collab.press");
        },
      }),
    },
    branchResolver: {
      branches: workBranches,
      workBranchDisposal: createDrizzleWorkBranchDisposal(deps.db, {
        branches: workBranches,
        treeLists: deps.treeLists,
        live: persistence.journal,
        liveCoordinator,
        onCommitted: async (documentId) => {
          await runDocumentWriteHook({ documentId }, "collab.work-purge");
        },
      }),
      documentPurgeDisposal: createDrizzleDocumentPurgeDisposal(deps.db, {
        closeRemovedRooms: (documentIds) =>
          closeRemovedDocumentRooms(
            hocuspocusBinding.current(),
            documentIds,
            removalRecords.lookup,
          ),
      }),
    },
    documentCreation,
  });
}
