/** Focused real-Postgres harness for collab durability tests. */

import type { WriteCommand } from "@meridian/agent-edit/integration";
import {
  createAgentEditCodecFactory,
  type ObservationFrontier,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { updateYFragment } from "@tiptap/y-tiptap";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { createAllowAllFileAccess } from "../../../domains/file-policy/index.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { closeTestDatabase } from "../../../test-support/drizzle-reset.js";
import { grantedJournal, testFileGrant } from "../../../test-support/file-grants.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { createDrizzleBranchDiscard } from "../adapters/drizzle-branch-discard.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../adapters/drizzle-branches.js";
import { createDrizzleCollabLookups } from "../adapters/drizzle-collab-lookups.js";
import { createDrizzleAuthorityGenerationReader } from "../adapters/drizzle-document-authority-head.js";
import { createDrizzleDocumentCommands } from "../adapters/drizzle-document-commands.js";
import { createDrizzleDraftReplayJournalReads } from "../adapters/drizzle-draft-journal-reads.js";
import { enterLiveWriteSeam } from "../adapters/drizzle-journal.js";
import { createDrizzleModelEdits } from "../adapters/drizzle-model-edits.js";
import { createDrizzleModelEvidence } from "../adapters/drizzle-model-evidence.js";
import { createDrizzleTurnInverseService } from "../adapters/drizzle-turn-inverse.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "../adapters/in-memory/static-document-link-scopes.js";
import type { RoutedWriteContext } from "../domain/agent-edit-cores.js";
import { createAgentEditRouter } from "../domain/agent-edit-router.js";
import { createBranchDiscard } from "../domain/branch-discard.js";
import { createBranchReviewIdentity } from "../domain/branch-review-identity.js";
import { createBranches } from "../domain/branches.js";
import { boundDocumentAuthority } from "../domain/document-handle.js";
import { scopeModelEditWrite } from "../domain/document-link-scope-doors.js";
import { createDraftRetirement } from "../domain/draft-retirement.js";
import { createModelDocumentEdits } from "../domain/model-document-edits.js";
import { createModelEditWriter } from "../domain/model-edit-write.js";
import { liveRoom } from "../domain/observation-rooms.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import { createThreadCores } from "../thread-cores.js";
import { modelWrite } from "./model-write.js";

const { createDb } = await import("@meridian/database");
export const schema = await import("@meridian/database/schema");
const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
  "@meridian/database/__test-support__/db-fixtures"
);
const { createDrizzleNoticePort } = await import("../../notices/index.js");
export const {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  deferUntilDrizzleRollback,
  runAfterDrizzleCommit,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} = await import("../../../shared/drizzle-transaction.js");
export const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
  "../../../test-support/drizzle-reset.js"
);
const { createDrizzleWorkBranchPendingStore } = await import(
  "../adapters/drizzle-work-branch-pending.js"
);
const { createBranchReviewItems } = await import("../domain/branch-review-items.js");
const { createTreeReader } = await import("../../context/tree/tree-view.js");
const { createFixtureDraftStore } = await import("./fixture-draft-store.js");
const { createDrizzleCollabPersistence } = await import("../adapters/drizzle-journal.js");
const { createDeferredLiveProjectionCoordinator, createHocuspocusCoordinator } = await import(
  "../adapters/hocuspocus-coordinator.js"
);
const {
  createAgentEditObservabilityOptions,
  createDocumentProjectionDiagnostics,
  createReversalNoticeDiagnostics,
} = await import("../adapters/agent-edit-observability.js");
const { createAgentEditRuntime } = await import("../domain/agent-edit-runtime.js");
const { scopeAgentEdit } = await import("../domain/document-link-scope-doors.js");
const { createDraftCoordinator } = await import("../domain/draft-coordinator.js");
const { createDraftPullService } = await import("../domain/draft-pulls.js");
const { createDraftProjection } = await import("../domain/draft-projection.js");
const { settleBefore } = await import("./converged-review.js");
const { createDocumentWriteHookRunner } = await import(
  "../domain/document-projection-refresher.js"
);
const { createReversalNoticePort } = await import("../domain/reversal-notices.js");
const { createTurnReversalService } = await import("../domain/turn-reversal-service.js");
const { UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS } = await import(
  "../adapters/declared-stubs.js"
);
const { createWorkBranchReviewService } = await import("../domain/work-branch-review-service.js");

/** Each suite owns its connection; importing this module allocates no database resources. */
export function createTestDatabase(): Database {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for DB tests");
  assertThrowawayDatabaseForRunDbTests(databaseUrl);
  return createDb(databaseUrl, { max: 4 });
}
const documentSchema = buildDocumentSchema();
const markupCodec = mdxCodec({
  schema: documentSchema,
});
const agentEditCodec = createAgentEditCodecFactory(markupCodec).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(documentSchema);

export const USER_ID = "00000000-0000-4000-8000-000000000801";
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000809";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
export const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
export const WORK_ID = "00000000-0000-4000-8000-000000000804" as WorkId;
export const ALPHA_ID = "00000000-0000-4000-8000-000000000805" as DocumentId;
export const BETA_ID = "00000000-0000-4000-8000-000000000806" as DocumentId;
export const GAMMA_ID = "00000000-0000-4000-8000-000000000810" as DocumentId;
export const THREAD_ID = "00000000-0000-4000-8000-000000000807" as ThreadId;
export const TURN_ID = "00000000-0000-4000-8000-000000000808" as TurnId;

export const DEFAULT_SCENARIO_IDS = {
  PROJECT_ID,
  SOURCE_ID,
  WORK_ID,
  ALPHA_ID,
  BETA_ID,
  GAMMA_ID,
  THREAD_ID,
  TURN_ID,
};
export type CollabScenarioIds = typeof DEFAULT_SCENARIO_IDS;

export async function resetDatabase(db: Database): Promise<void> {
  // Clear the graph in this runner-owned disposable database using FK-ordered deletes.
  await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
  await seedDatabase(db);
}

/** Independent rows let warm and cold runs coexist without wiping durable evidence. */
export async function seedDatabase(
  db: Database,
  ids: CollabScenarioIds = DEFAULT_SCENARIO_IDS,
): Promise<void> {
  const { PROJECT_ID, SOURCE_ID, WORK_ID, ALPHA_ID, BETA_ID, GAMMA_ID, THREAD_ID, TURN_ID } = ids;
  await db
    .insert(schema.users)
    .values([
      conformanceUserValues(USER_ID, "response-atomicity"),
      conformanceUserValues(OTHER_USER_ID, "response-atomicity-other"),
    ])
    .onConflictDoNothing();
  await db.insert(schema.projects).values({
    id: PROJECT_ID,
    userId: USER_ID,
    name: "Atomicity",
    slug: `atomicity-${PROJECT_ID}`,
  });
  await db.insert(schema.works).values({
    id: WORK_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    name: "Atomicity work",
    handle: "w1",
  });
  // The Work already has its branch, as if an earlier write ensured it (contract §2.5):
  // a drafted read pulls its thread peers instead of reading live.
  await db.insert(schema.branches).values({
    projectId: PROJECT_ID,
    originWorkId: WORK_ID,
    createdBy: USER_ID,
  });
  await db.insert(schema.contextSources).values({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    name: "Manuscript",
    slug: "manuscript",
    scope: "project",
  });
  await db.insert(schema.documents).values([
    {
      id: ALPHA_ID,
      contextSourceId: SOURCE_ID,
      name: "alpha",
      extension: "",
      fileType: "markdown",
    },
    {
      id: BETA_ID,
      contextSourceId: SOURCE_ID,
      name: "beta",
      extension: "",
      fileType: "markdown",
    },
    {
      id: GAMMA_ID,
      contextSourceId: SOURCE_ID,
      name: "third",
      extension: "md",
      fileType: "markdown",
    },
  ]);
  await db.insert(schema.threads).values({
    rootThreadId: THREAD_ID,
    id: THREAD_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Thread",
    kind: "primary",
    status: "idle",
    aiWriteMode: "draft",
  });
  await db.insert(schema.turns).values({
    id: TURN_ID,
    threadId: THREAD_ID,
    position: 1,
    role: "assistant",
    origin: "assistant",
    status: "complete",
  });
  await db.insert(schema.threadWorks).values({
    threadId: THREAD_ID,
    workId: WORK_ID,
    projectId: PROJECT_ID,
    isPrimary: true,
  });
}
export async function closeDatabase(db: Database): Promise<void> {
  await closeTestDatabase(db);
}

export type CollabHarnessOptions = {
  ids?: CollabScenarioIds;
  /** Default: every grant is confirmed. */
  fileAccess?: import("../../file-policy/index.js").FileAccess;
  /** Default: a static scope, whose tokens ignore the tree. */
  links?: DocumentLinkScopes;
  /** Ahead-ref settlement at Apply's arrivals; absent, completions settle nothing. */
  arrivals?: DocumentArrivals;
};

export function createHarness(db: Database, options: CollabHarnessOptions = {}) {
  // One link scope for every door the harness assembles, as composition shares one.
  const links = options.links ?? createStaticDocumentLinkScopes();
  const { ALPHA_ID, GAMMA_ID, THREAD_ID, TURN_ID } = options.ids ?? DEFAULT_SCENARIO_IDS;
  const documentName = (documentId: DocumentId) =>
    documentId === ALPHA_ID ? "alpha" : documentId === GAMMA_ID ? "third" : "beta";
  const DRAFT_DESTINATION = {
    kind: "draft",
    owner: { kind: "work", workId: (options.ids ?? DEFAULT_SCENARIO_IDS).WORK_ID },
    ownerHandle: "atomicity-work",
  } as const;
  const persistence = createDrizzleCollabPersistence(db);
  const _testJournal = grantedJournal(persistence.journal);
  const hocuspocus = fakeHocuspocus();
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: () => hocuspocus as never,
    journal: persistence.journal,
  });
  const workBranches = createBranches({
    store: createDrizzleBranchStore(db),
    boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
  });
  // One closer for the harness's drafts, Discard and removals; its retirement binds below.
  const { draftClose, documentRemoval } = createTestRemovalDeps(db);
  const draftStore = createFixtureDraftStore(db, {
    close: draftClose,
    workProjection: createTestWorkProjectionMutation(db),
    live: {
      journal: persistence.journal,
    },
    branches: workBranches,
  });
  const draftCoordinator = createDraftCoordinator({
    onAppendCommitted: (draftId) => draftEffects.markDirty(draftId),
    store: draftStore,
    attemptScope: (operation) => runInDrizzleSavepoint(db, operation),
  });
  const draftPulls = createDraftPullService({
    outsideTransaction: runOutsideWrite,
    draftCoordinator,
    drafts: draftStore,
    liveJournal: persistence.journal,
  });
  const draftEffects = createDraftProjection({
    coordinator: draftCoordinator,
    store: draftStore,
    outsideTransaction: runOutsideWrite,
  });
  const notices = createDrizzleNoticePort(db);
  const durableDraftJournalReadStore = createDrizzleDraftReplayJournalReads(db);
  const durableWorkBranchPendingStore = createDrizzleWorkBranchPendingStore(db);
  const events: Array<{
    name: string;
    level: string;
    payload: Record<string, unknown>;
    correlation?: object;
  }> = [];
  const eventSink: import("../../observability/index.js").EventSink = {
    emit(event) {
      events.push({
        name: event.name,
        level: event.level,
        payload: event.payload,
        correlation: event.correlation,
      });
    },
    emitBatch(batch) {
      for (const event of batch)
        events.push({
          name: event.name,
          level: event.level,
          payload: event.payload,
          correlation: event.correlation,
        });
    },
    flush: async () => {},
  };
  const resolveDocumentUri = async (documentId: string) =>
    `manuscript/${documentName(documentId as DocumentId)}.md`;
  const projectionDiagnostics = createDocumentProjectionDiagnostics(eventSink);
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: async () => {},
    diagnostics: projectionDiagnostics,
  });
  const observability = createAgentEditObservabilityOptions({ eventSink });
  const modelDocumentEdits = createModelDocumentEdits({
    service: () => turnInverse,
    drafts: draftStore,
    coordinator: liveCoordinator,
  });
  const runtime = createAgentEditRuntime({
    documentEdits: modelDocumentEdits,
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    journal: persistence.journal,
    coordinator: liveCoordinator,
    agentCoordinator: createDeferredLiveProjectionCoordinator({
      hocuspocus: () => hocuspocus as never,
      journal: persistence.journal,
      live: liveCoordinator,
      transactions: {
        inTransaction: isInDrizzleTransaction,
        outsideTransaction: runOutsideDrizzleTransaction,
        afterCommit: deferUntilDrizzleCommit,
      },
    }),
    initialDocumentSeeds: persistence.seeds,
    runDocumentWriteHook,
    resolveDocumentFiletype: async () => null,
    observability,
    inTransaction: isInDrizzleTransaction,
  });
  const projections = { refresh: runDocumentWriteHook };
  const threadCore = createThreadCores({
    documentEdits: modelDocumentEdits,
    journal: persistence.journal,
    drafts: draftStore,
    draftCoordinator,
    draftPulls,
    draftJournal: durableDraftJournalReadStore,
    model: runtime.model,
    codec: runtime.codec,
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    semanticProvenance: runtime.semanticProvenance,
    observability,
  });
  // Scoped as composition scopes it, so a real link scope sees every model call.
  const agentEdit = scopeAgentEdit(
    createAgentEditRouter({
      branches: workBranches,
      drafts: draftStore,
      liveUtilityCore: runtime.liveUtilityCore,
      threadCore,
    }),
    links,
  );
  const ensureWorkDraft = ({
    documentId,
    branchId,
  }: {
    documentId: DocumentId;
    branchId: string;
  }) =>
    liveCoordinator.withDocument(documentId, (liveDoc) => {
      const authority = boundDocumentAuthority(liveDoc);
      if (!authority) throw new Error(`Live document ${documentId} has no authority binding`);
      return draftStore.ensureDocumentDraft({
        documentId,
        branchId: branchId as never,
        liveDoc,
        liveRoom: liveRoom(documentId, authority.generation),
      });
    });
  const modelEvidence = createDrizzleModelEvidence(db);
  const modelEdits = createDrizzleModelEdits(
    db,
    {
      write: scopeModelEditWrite(
        createModelEditWriter({
          evidence: modelEvidence,
          liveCore: runtime.liveUtilityCore,
          threadCore,
          branches: workBranches,
          fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
          enterLiveSeam: (documentId) => enterLiveWriteSeam(db, documentId),
          enterDraftSeam: async () => {
            await lockSeamWorks(db, []);
          },
          ensureWorkDraft,
          lockDraft: async (draftId) => {
            await currentDrizzleDb(db)
              .select({ id: schema.documentDrafts.id })
              .from(schema.documentDrafts)
              .where(eq(schema.documentDrafts.id, draftId))
              .for("update");
          },
          roomsOf: async (documentId) => ({
            liveRoom: liveRoom(documentId, await readAuthorityGeneration(documentId)),
            drafts: await draftStore.listWorkDraftStates(documentId),
          }),
          afterLiveCommit: (documentId) =>
            deferUntilDrizzleCommit(() => draftPulls.scheduleLivePull(documentId)),
        }),
        links,
      ),
      catchUp: (documentId) => draftPulls.flushLivePull(documentId),
    },
    modelEvidence,
  );
  const readAuthorityGeneration = createDrizzleAuthorityGenerationReader(db);
  const turnInverse = createDrizzleTurnInverseService({
    onDraftCommitted: (draftId) => draftEffects.markDirty(draftId),
    db,
    journal: persistence.journal,
    drafts: draftStore,
    coordinator: liveCoordinator,
    draftCoordinator,
    resolveDocumentUri,
    refreshDocument: (documentId) => projections.refresh({ documentId }),
    flushLivePull: draftPulls.flushLivePull,
    notices: createReversalNoticePort({
      notices,
      documentUriResolver: resolveDocumentUri,
      diagnostics: createReversalNoticeDiagnostics(eventSink),
    }),
    workProjection: createTestWorkProjectionMutation(db),
    removal: documentRemoval,
    ...(options.arrivals ? { arrivals: options.arrivals } : {}),
    catalog: { refreshSources: async () => "" },
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
  });
  const turnReversal = createTurnReversalService({
    ...UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
    turnInverse,
    resolveDocumentUri,
    commands: createDrizzleDocumentCommands(db),
  });
  const reviewItems = createBranchReviewItems({
    tree: createTreeReader(db),
    drafts: (branchId, documentIds) =>
      durableWorkBranchPendingStore.listBranchDraftMetadata(branchId, documentIds),
    pendingThreadIds: durableWorkBranchPendingStore.pendingThreadIds,
    treeActors: (branchId, documentIds) =>
      durableWorkBranchPendingStore.listTreeActors(branchId, documentIds),
  });
  // The harness keeps no draft rooms but the fake hocuspocus's: retirement closes those and
  // the pooled cores' thread state.
  const closeDraftRoom = (draftId: string) => {
    for (const roomId of [...hocuspocus.documents.keys()]) {
      if (roomId !== `draft:${draftId}`) continue;
      hocuspocus.documents.get(roomId)?.destroy();
      hocuspocus.documents.delete(roomId);
    }
  };
  draftClose.bindRetirement(
    createDraftRetirement({
      closeDraftRoom,
      async closeRemovedRooms(_documentIds, draftIds) {
        for (const draftId of draftIds) closeDraftRoom(draftId);
      },
    }),
    (error) => {
      throw error;
    },
  );
  const lookups = createDrizzleCollabLookups(db);
  const identity = createBranchReviewIdentity({ branches: workBranches, reviewItems });
  const branches = createWorkBranchReviewService({
    applyClick: async () => {
      throw new Error("Apply click is not configured in the collab fixture");
    },
    unapplyClick: async () => {
      throw new Error("Un-Apply click is not configured in the collab fixture");
    },
    branches: workBranches,
    reviewItems,
    pending: durableWorkBranchPendingStore,
    identity,
    discard: createBranchDiscard({
      branches: workBranches,
      attemptScope: (operation) => runInDrizzleSavepoint(db, operation),
      // No Work projection in this harness: pending counts aren't under test.
      store: createDrizzleBranchDiscard(db, {
        removal: documentRemoval,
        close: draftClose,
        branches: workBranches,
        workProjection: createTestWorkProjectionMutation(db),
        catalog: { refreshSources: async () => "" },
      }),
      holdRetirement: draftClose.holdRetirement,
      releaseObjects: async () => {},
    }),
    commands: createDrizzleDocumentCommands(db),
    resolveThreadTitles: lookups.resolveThreadTitles,
  });
  // Tests mint a destination grant without a target; a write's grant names its document. A
  // write is the model's tool call as the chat loop sends it: one command, one transaction.
  const testAgentEdit = {
    ...agentEdit,
    write: (command: WriteCommand, context: RoutedWriteContext) => {
      const target = "documentId" in command ? command.documentId : undefined;
      return modelWrite(
        modelEdits,
        command,
        target
          ? {
              ...context,
              grant: {
                ...context.grant,
                facts: { ...context.grant.facts, target: { kind: "document", documentId: target } },
              },
            }
          : context,
        { accountId: USER_ID, projectId: PROJECT_ID },
      );
    },
  };
  const collab = {
    agentEdit: () => testAgentEdit,
    reverseTurn: turnReversal.reverseTurn,
    getTurnReceiptChip: turnInverse.getTurnReceiptChip,
    writeDocument: runtime.markdownDocuments.writeDocument,
    bindMarkdown: runtime.linkBinder.bindMarkdown,
    ...branches,
  };
  // Review membership is projected after an append commits; review reads wait for it.
  settleBefore(collab.draftReview, draftEffects.flush);

  // The host's frontier store: a seeded write plans on the view its read showed.
  const shownFrontiers = new Map<string, ObservationFrontier>();
  const lookupShown = async (room: string) => shownFrontiers.get(room) ?? null;
  const _modelFrontiers = { recording: lookupShown, planning: lookupShown };
  function _remember<T extends { frontier?: ObservationFrontier }>(outcome: T): T {
    if (outcome.frontier) shownFrontiers.set(outcome.frontier.room, outcome.frontier);
    return outcome;
  }

  /**
   * The Work draft a draft-mode write ensures before its room read. A read
   * never makes them (S1), so a fixture that seeds drafted content provisions them first.
   */
  async function provisionDraft(documentId: DocumentId = ALPHA_ID) {
    await persistence.seeds.seedInitialDocument(
      documentId,
      Y.encodeStateAsUpdate(new Y.Doc({ gc: false })),
    );
    const scenario = options.ids ?? DEFAULT_SCENARIO_IDS;
    const branch = await workBranches.ensureActiveForWrite({
      owner: { kind: "work", workId: scenario.WORK_ID },
      projectId: scenario.PROJECT_ID as never,
      threadId: THREAD_ID,
      userId: USER_ID as never,
    });
    return ensureWorkDraft({ documentId, branchId: branch.id });
  }

  async function seedWriterDocument(markdown: string, responseId: string): Promise<void> {
    await persistence.seeds.seedInitialDocument(ALPHA_ID, Y.encodeStateAsUpdate(new Y.Doc()));
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, markdown);
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    await provisionDraft();
    await collab.agentEdit().read(
      { file: "alpha.md", documentId: ALPHA_ID },
      {
        grant: testFileGrant(DRAFT_DESTINATION),
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseIdentity: { modelResponseId: responseId },
      },
    );
  }

  return {
    draftMarkdown: (draftId: string) =>
      draftCoordinator.readDraft(draftId, async (doc) => serializeMarkdown(doc)),
    seedWriterDocument,
    crossWorkProbeFixture: () => ({
      provisionDraft,
      runtime,
      links,
      draftPulls,
      db,
      schema,
      persistence,
      liveCoordinator,
      collab,
      draftStore,
      draftCoordinator,
      draftMarkdown: (draftId: string) =>
        draftCoordinator.readDraft(draftId, async (doc) => serializeMarkdown(doc)),
      hocuspocus,
      model,
      markupCodec,
      agentEditCodec,
    }),
    /** Stop producers and join their work before test reset or pool shutdown. */
    async dispose() {
      await Promise.all([draftPulls.shutdown(), draftEffects.dispose()]);
      for (const doc of hocuspocus.documents.values()) doc.destroy();
      hocuspocus.documents.clear();
      hocuspocus.broadcasts.length = 0;
    },
    /** Cancels future pulls while a race fixture keeps the rest of its runtime active. */
    cancelScheduledPulls: () => {
      draftPulls.cancelScheduledPulls();
    },
    /** Waits for every draft-effect judgement the test's writes scheduled. */
    settleDraftEffects: () => draftEffects.flush(),
    reverseTurn: (direction: "undo" | "redo") =>
      collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction,
        actor: { type: "user", userId: USER_ID },
      }),
    liveMarkdown: (documentId: DocumentId) =>
      liveCoordinator.withDocument(documentId, async (doc) => serializeMarkdown(doc)),
    liveUpdateCount: async () => (await db.select().from(schema.documentYjsUpdates)).length,
  };
}

function serializeMarkdown(doc: Y.Doc): string {
  const nodes = model.projectBlocks(toDocHandle(doc)).map((block) => block.node);
  return nodes.length === 0 ? "" : markupCodec.serialize(nodes, UNSCOPED_DOCUMENT_LINKS);
}

function replaceMarkdown(doc: Y.Doc, markdown: string): void {
  const parsed = markupCodec.parse(markdown);
  const replacement = documentSchema.node("doc", null, parsed.blocks);
  updateYFragment(doc, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), replacement, {
    mapping: new Map(),
    isOMark: new Map(),
  });
}

function fakeHocuspocus() {
  const documents = new Map<string, Y.Doc>();
  const broadcasts: string[] = [];
  return {
    documents,
    broadcasts,
    async openDirectConnection(documentName: string) {
      let document = documents.get(documentName);
      if (!document) {
        document = new Y.Doc({ gc: false });
        document.clientID = Number.parseInt(documentName.replaceAll("-", "").slice(-7), 16);
        document.on("update", () => broadcasts.push(documentName));
        documents.set(documentName, document);
      }
      return { document, disconnect: async () => undefined };
    },
  };
}
