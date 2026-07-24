/** Focused real-Postgres harness for change-trail durability tests. */
import {
  createAgentEditCodec,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";

const { createDb } = await import("@meridian/database");
export const schema = await import("@meridian/database/schema");
const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
  "@meridian/database/__test-support__/db-fixtures"
);
const { createDrizzleNoticePort } = await import("../../notices/index.js");
const { createActiveDocumentResolver } = await import("../../threads/index.js");
const { createDrizzleRepositories } = await import("../../threads/adapters/drizzle/index.js");
export const { runInDrizzleTransaction, runInRootDrizzleTransaction } = await import(
  "../../../shared/drizzle-transaction.js"
);
export const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
const {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
  createDrizzleWorkPushPolicyStore,
} = await import("../adapters/drizzle-branch-push.js");
const { createDrizzlePendingSettlementStore, stagePendingSettlementWithinTx } = await import(
  "../adapters/drizzle-pending-settlement.js"
);
const { createChangeTrailWorker } = await import("../adapters/change-trail-worker.js");
const { createDrizzleChangeTrailPersistence } = await import(
  "../adapters/drizzle-change-trails.js"
);
const { createDrizzleBranchStore } = await import("../adapters/drizzle-branches.js");
const {
  createDrizzleDocumentAuthorityHeads,
  readDocumentAuthorityHead,
  replaceDocumentAuthorityHeadGeneration,
} = await import("../adapters/drizzle-document-authority-head.js");
const { lockDocumentMutation } = await import("../adapters/drizzle-document-mutation-lock.js");
const { createDrizzleCollabPersistence } = await import("../adapters/drizzle-journal.js");
const { createHocuspocusCoordinator } = await import("../adapters/hocuspocus-coordinator.js");
const { createFacade, createFacadeRuntime } = await import("../composition.js");
const { createBranchConcurrentJournalWatermarks } = await import("../domain/branch-agent-edit.js");
const { createBranchCoordinator } = await import("../domain/branch-coordinator.js");
const { createBranchCriticalSections } = await import("../domain/branch-critical-sections.js");
const { createBranchPullService } = await import("../domain/branch-pulls.js");
const { createBranchPushService } = await import("../domain/branch-push.js");
const { createBranchReviewOperations } = await import("../domain/branch-review-operations.js");
const { replicateFrozenIdentity } = await import("../domain/document-mutation-policy.js");
const { createMarkdownDocumentEngine } = await import("../domain/markdown-document.js");
const { appendProvenanceFacts, createSemanticProvenanceWriter, PROVENANCE_TARGETS_TYPE } =
  await import("../domain/provenance.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required for DB tests");
assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
export const db = createDb(DATABASE_URL, { max: 4 });
const documentSchema = buildDocumentSchema();
const markupCodec = mdxCodec({ schema: documentSchema });
const agentEditCodec = createAgentEditCodec(markupCodec);
const model = yProsemirrorModel(documentSchema);

export const USER_ID = "00000000-0000-4000-8000-000000000801";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
export const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
export const WORK_ID = "00000000-0000-4000-8000-000000000804" as WorkId;
export const ALPHA_ID = "00000000-0000-4000-8000-000000000805" as DocumentId;
export const BETA_ID = "00000000-0000-4000-8000-000000000806" as DocumentId;
export const THREAD_ID = "00000000-0000-4000-8000-000000000807" as ThreadId;
export const TURN_ID = "00000000-0000-4000-8000-000000000808" as TurnId;

export async function resetDatabase(): Promise<void> {
  await truncateDrizzleTables(db, [
    schema.turnTrailWork,
    schema.changeTrailDeliveryOutbox,
    schema.changeTrailDocumentDetails,
    schema.changeTrailShells,
    schema.pendingNoticeDeliveries,
    schema.pendingNotices,
    schema.agentEditMutations,
    schema.branchWriteJournal,
    schema.pushLineage,
    schema.documentBranches,
    schema.documentYjsCheckpoints,
    schema.documentYjsHeads,
    schema.documentYjsUpdates,
    schema.threadWorks,
    schema.turns,
    schema.threads,
    schema.folders,
    schema.documents,
    schema.contextSources,
    schema.works,
    schema.projects,
    schema.users,
  ]);
  await db.insert(schema.users).values(conformanceUserValues(USER_ID, "response-atomicity"));
  await db.insert(schema.projects).values({
    id: PROJECT_ID,
    userId: USER_ID,
    name: "Atomicity",
    slug: "atomicity",
  });
  await db.insert(schema.works).values({
    id: WORK_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Atomicity work",
    aiWriteMode: "draft",
  });
  await db.insert(schema.contextSources).values({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    name: "Manuscript",
    slug: "manuscript",
    scope: "project",
    isPrimary: true,
  });
  await db.insert(schema.documents).values([
    {
      id: ALPHA_ID,
      contextSourceId: SOURCE_ID,
      name: "alpha",
      extension: "md",
      fileType: "markdown",
    },
    {
      id: BETA_ID,
      contextSourceId: SOURCE_ID,
      name: "beta",
      extension: "md",
      fileType: "markdown",
    },
  ]);
  await db.insert(schema.threads).values({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Thread",
    kind: "primary",
    status: "active",
  });
  await db.insert(schema.turns).values({
    id: TURN_ID,
    threadId: THREAD_ID,
    role: "assistant",
    status: "complete",
  });
  await db.insert(schema.threadWorks).values({
    threadId: THREAD_ID,
    workId: WORK_ID,
    projectId: PROJECT_ID,
    isPrimary: true,
  });
}
export async function closeDatabase(): Promise<void> {
  await db.$client.end();
}

export function markdownFromUpdate(update: Uint8Array): string {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, update);
    return serializeMarkdown(doc);
  } finally {
    doc.destroy();
  }
}
export type ChangeTrailHarnessOptions = {
  /** Suspends the real transition after its awaited preparation reads, while the live lock is held. */
  duringAwaitedPreparation?: () => Promise<void>;
  afterDurableCommit?: (input: {
    documentIds: readonly DocumentId[];
    appendWriterPrefix(documentId: DocumentId, prefix: string): Promise<void>;
    deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
  }) => Promise<void>;
  afterSettlement?: (input: {
    documentId: DocumentId;
    deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
    stateVector(documentId: DocumentId): Uint8Array;
  }) => Promise<void>;
  afterLiveApply?: () => void;
};

export type MatrixDraftStep = {
  source: "writer" | "agent";
  markdown: string;
  remint?: boolean;
  /** Certifies a length-preserving structural re-mint as one preserved root run. */
  certifiedCarry?: boolean;
  transientInsertDelete?: string;
};

export function createHarness(options: ChangeTrailHarnessOptions = {}) {
  const persistence = createDrizzleCollabPersistence(db);
  const hocuspocus = fakeHocuspocus();
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: () => hocuspocus as never,
    journal: persistence.journal,
  });
  const branchCriticalSections = createBranchCriticalSections();
  const realBranchStore = createDrizzleBranchStore(
    db,
    {
      journal: persistence.journal,
      lifecycle: persistence.lifecycle,
      coordinator: liveCoordinator,
    },
    branchCriticalSections,
  );
  let journalInsertCount = 0;
  const state = { failSecondJournalInsert: false };
  function injectSecondJournalFailure(): void {
    if (++journalInsertCount === 2 && state.failSecondJournalInsert) {
      throw new Error("injected second-document journal failure");
    }
  }
  const branchStore = {
    ...realBranchStore,
    async appendJournal(input: Parameters<NonNullable<typeof realBranchStore.appendJournal>>[0]) {
      injectSecondJournalFailure();
      return realBranchStore.appendJournal?.(input);
    },
    async commitBranchMutation(
      input: Parameters<NonNullable<typeof realBranchStore.commitBranchMutation>>[0],
    ) {
      if (input.journal) injectSecondJournalFailure();
      return realBranchStore.commitBranchMutation?.(input) ?? false;
    },
  };
  const branchBroadcasts: string[] = [];
  const branchCoordinator = createBranchCoordinator({
    store: branchStore,
    criticalSections: branchCriticalSections,
    onBranchUpdate: ({ branchId }) => branchBroadcasts.push(branchId),
  });
  const realWatermarks = createBranchConcurrentJournalWatermarks();
  const pendingWatermarks = new Set<string>();
  const watermarkCommits: string[] = [];
  const watermarkKey = (threadId: ThreadId, documentId: DocumentId) => `${threadId}:${documentId}`;
  const watermarks = {
    current: realWatermarks.current,
    capturePending(threadId: ThreadId, documentId: DocumentId, id: number, attemptId?: string) {
      pendingWatermarks.add(watermarkKey(threadId, documentId));
      realWatermarks.capturePending(threadId, documentId, id, attemptId);
    },
    commitPending(threadId: ThreadId, documentId: DocumentId, attemptId?: string) {
      pendingWatermarks.delete(watermarkKey(threadId, documentId));
      watermarkCommits.push(watermarkKey(threadId, documentId));
      realWatermarks.commitPending(threadId, documentId, attemptId);
    },
    clearPending(threadId: ThreadId, documentId: DocumentId) {
      pendingWatermarks.delete(watermarkKey(threadId, documentId));
      realWatermarks.clearPending(threadId, documentId);
    },
  };
  const branchPulls = createBranchPullService({
    liveCoordinator,
    branchCoordinator,
    branches: branchStore,
    concurrentJournalWatermarks: watermarks,
  });
  const realNotices = createDrizzleNoticePort(
    db,
    createActiveDocumentResolver(createDrizzleRepositories(db)),
  );
  const noticeState = { fail: false };
  let noticeRecordAttempts = 0;
  const notices = {
    ...realNotices,
    async record(input: Parameters<typeof realNotices.record>[0]) {
      noticeRecordAttempts += 1;
      if (noticeState.fail) throw new Error("injected notice failure");
      return realNotices.record(input);
    },
  };
  const changeTrails = createDrizzleChangeTrailPersistence(db);
  const durableProjectionSerializer = createMarkdownDocumentEngine({
    schema: documentSchema,
    model,
    codec: markupCodec,
    journal: persistence.journal,
    coordinator: liveCoordinator,
    lifecycle: persistence.lifecycle,
    initialDocumentSeeds: persistence.lifecycle,
    metaForOrigin: () => ({ origin: "system", seq: 0 }),
    resolveFiletype: async (documentId) => {
      const [row] = await db
        .select({ filetype: schema.documents.fileType })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentId));
      return row?.filetype ?? null;
    },
  });
  const durableBranchJournalReadStore = createDrizzleBranchJournalReadStore(db);
  const durablePushCommitStore = createDrizzlePushCommitStore(
    db,
    stagePendingSettlementWithinTx,
    changeTrails,
    notices,
  );
  const durableWorkPushPolicyStore = createDrizzleWorkPushPolicyStore(db);
  const durableSettlementStore = createDrizzlePendingSettlementStore(
    db,
    durableProjectionSerializer,
    changeTrails,
    notices,
  );
  const appendWriterPrefix = async (documentId: DocumentId, prefix: string) => {
    const doc = hocuspocus.documents.get(documentId);
    if (!doc) throw new Error("warm live document is unavailable after push commit");
    const block = model.getBlocks(toDocHandle(doc))[0];
    if (!block) throw new Error("writer target is unavailable after push commit");
    const before = Y.encodeStateVector(doc);
    model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, prefix);
    await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  };
  const deleteWriterPrefix = async (documentId: DocumentId, length: number) => {
    const doc = hocuspocus.documents.get(documentId);
    if (!doc) throw new Error("warm live document is unavailable after push commit");
    const block = model.getBlocks(toDocHandle(doc))[0];
    if (!block) throw new Error("writer target is unavailable after push commit");
    const before = Y.encodeStateVector(doc);
    model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: length }, "");
    await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  };
  const settlementStore = {
    ...durableSettlementStore,
    async settlePushTrail(input: Parameters<typeof durableSettlementStore.settlePushTrail>[0]) {
      const settled = await durableSettlementStore.settlePushTrail(input);
      if (settled !== false) {
        await options.afterSettlement?.({
          documentId: input.push.documentId,
          deleteWriterPrefix,
          stateVector(documentId) {
            const doc = hocuspocus.documents.get(documentId);
            if (!doc) throw new Error("warm live document is unavailable after settlement");
            return Y.encodeStateVector(doc);
          },
        });
      }
      return settled;
    },
    async withCompletionFence(
      input: Parameters<typeof durableSettlementStore.withCompletionFence>[0],
      complete: Parameters<typeof durableSettlementStore.withCompletionFence>[1],
    ) {
      return durableSettlementStore.withCompletionFence(input, () => {
        const result = complete();
        options.afterLiveApply?.();
        return result;
      });
    },
  };

  const realBranchPush = createBranchPushService({
    branchStore,
    criticalSections: branchCriticalSections,
    journalReadStore: durableBranchJournalReadStore,
    commitStore: durablePushCommitStore,
    workPushPolicyStore: durableWorkPushPolicyStore,
    settlementStore,
    branchCoordinator,
    journal: persistence.journal,
    liveCoordinator,
    model,
    codec: markupCodec,
    notices,
    resolveDocumentTitle: async (documentId) => {
      await options.duringAwaitedPreparation?.();
      return documentId === ALPHA_ID ? "alpha" : "beta";
    },
    hooks: options.afterDurableCommit
      ? {
          afterDurableCommit: async (documentIds) =>
            options.afterDurableCommit?.({
              documentIds,
              appendWriterPrefix,
              deleteWriterPrefix,
            }),
        }
      : undefined,
  });
  const branchReview = createBranchReviewOperations({
    branchStore,
    journalReadStore: durableBranchJournalReadStore,
    commitStore: durablePushCommitStore,
    branchCoordinator,
    journal: persistence.journal,
    criticalSections: branchCriticalSections,
  });
  const deliveredEvents: unknown[] = [];
  const fences: Array<{ threadId: string; documentId: string }> = [];
  let failNextTrailRetry = false;
  let failAllTrailRetries = false;
  const trailDelivery = createChangeTrailWorker({
    db,
    journalWriter: {
      async appendEvent(_threadId: string, event: unknown) {
        deliveredEvents.push(event);
        return deliveredEvents.length;
      },
    } as never,
    eventHub: { publishPersistedEvent() {} },
    retryBranch: (branchId) => {
      if (failAllTrailRetries || failNextTrailRetry) {
        failNextTrailRetry = false;
        throw new Error("injected retryable auto-push failure");
      }
      return realBranchPush.pushToLive({ branchId, overlapPolicy: "apply_and_trail" });
    },
    onRetryExhausted: (threadId, documentId) => fences.push({ threadId, documentId }),
  });
  const autoPushSchedules: string[] = [];
  const autoPushPromises: Promise<unknown>[] = [];
  const branchPush = {
    ...realBranchPush,
    async pushAutoBranchAfterThreadPeerWrite(input: { workDraftBranchId: string }) {
      autoPushSchedules.push(input.workDraftBranchId);
      const push = realBranchPush.pushAutoBranchAfterThreadPeerWrite(input);
      autoPushPromises.push(push);
      return push;
    },
  };
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  let preCommitBranchHashes: Array<{ id: string; state: string; stateVector: string }> = [];
  const facadeDeps: Parameters<typeof createFacade>[0] = {
    ...persistence,
    initialDocumentSeeds: persistence.lifecycle,
    documentAuthorityHeads: createDrizzleDocumentAuthorityHeads(db),
    coordinator: liveCoordinator,
    hocuspocus: () => hocuspocus as never,
    bindHocuspocus() {},
    liveLineage: {
      listLiveDocumentsForTurn: async () => [],
      listEditedDocumentsForTurn: async () => [],
      getTurnReceiptChip: async () => null,
    } as never,
    threads: { findById: async (threadId: ThreadId) => ({ id: threadId }) },
    notices,
    eventSink: {
      emit(event) {
        events.push({ name: event.name, payload: event.payload });
      },
      emitBatch(batch) {
        for (const event of batch) events.push({ name: event.name, payload: event.payload });
      },
      flush: async () => {},
    },
    branchStore,
    branchCoordinator,
    branchPulls,
    branchPush,
    branchReview,
    branchJournalReadStore: durableBranchJournalReadStore,
    workPushPolicyStore: durableWorkPushPolicyStore,
    concurrentJournalWatermarks: watermarks,
    documentUriResolver: async (documentId) =>
      documentId === ALPHA_ID ? "manuscript/alpha.md" : "manuscript/beta.md",
    resolveWorkWriteMode: async () => "draft",
    commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(db, operation),
  };
  const collab = createFacade(facadeDeps, createFacadeRuntime(facadeDeps));

  async function seedAndStage(responseId: string) {
    await collab.writeDocument({
      documentId: ALPHA_ID,
      markdown: "Alpha base.",
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    await collab.writeDocument({
      documentId: BETA_ID,
      markdown: "Beta base.",
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
    };
    // Establish thread peers first, then append a real concurrent work-draft row.
    // The following staged write must capture that row as a pending watermark.
    await collab
      .agentEdit()
      .write(
        { command: "read", file: "alpha.md", documentId: ALPHA_ID },
        { ...context, responseId: undefined },
      );
    await collab
      .agentEdit()
      .write(
        { command: "read", file: "beta.md", documentId: BETA_ID },
        { ...context, responseId: undefined },
      );
    for (const documentId of [ALPHA_ID, BETA_ID]) {
      const draft = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
      const last = model.getBlocks(toDocHandle(draft.doc)).at(-1) ?? null;
      model.insertBlocks(toDocHandle(draft.doc), last, markupCodec.parse("Writer concurrent."));
      await branchCoordinator.commitSyncFromDoc({
        branchId: draft.branchId,
        sourceDoc: draft.doc,
        expectedGeneration: draft.generation,
        source: "writer",
        actorUserId: USER_ID as never,
        threadId: THREAD_ID,
        turnId: null,
        wId: null,
        updateMeta: null,
      });
      draft.doc.destroy();
    }
    await expect(
      collab.agentEdit().write(
        {
          command: "insert",
          file: "alpha.md",
          documentId: ALPHA_ID,
          content: "Agent alpha.",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      collab
        .agentEdit()
        .write(
          { command: "insert", file: "beta.md", documentId: BETA_ID, content: "Agent beta." },
          context,
        ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    preCommitBranchHashes = await databaseBranchHashes();
    // Staging pulls legitimately publish into loaded branch rooms. Start the
    // measurement window after staging so it covers only the commit attempt.
    branchBroadcasts.length = 0;
    watermarkCommits.length = 0;
    autoPushSchedules.length = 0;
    hocuspocus.broadcasts.length = 0;
  }

  async function seedAndStageDestructive(
    responseId: string,
    documentId: DocumentId = ALPHA_ID,
    journalWriterEdit = true,
    markdown = "Alpha base.\n\nWriter block.",
    writerBlockIndex = 1,
    writerEditBeforeWrite = false,
  ) {
    const file = documentId === ALPHA_ID ? "alpha.md" : "beta.md";
    await collab.writeDocument({
      documentId,
      markdown,
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
      createdDocument: false,
    };
    await collab
      .agentEdit()
      .write({ command: "read", file, documentId }, { ...context, responseId: undefined });
    if (writerEditBeforeWrite) {
      await db.insert(schema.modelResponses).values({
        id: responseId as never,
        turnId: TURN_ID,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
      });
    }
    const applyWriterEdit = () =>
      liveCoordinator.withDocument(documentId, async (doc) => {
        const writerBlock = model.getBlocks(toDocHandle(doc))[writerBlockIndex];
        if (!writerBlock) throw new Error("writer block missing before concurrent edit");
        const before = Y.encodeStateVector(doc);
        model.applyTextEdit(
          toDocHandle(doc),
          writerBlock,
          { from: 0, to: 0 },
          "Writer concurrent edit: ",
        );
        if (journalWriterEdit) {
          await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
            origin: `human:${USER_ID}`,
            seq: 0,
          });
        }
      });
    // The probe edit lands after the response's read but before the destructive
    // tool call. Journaled fixtures retain their older phase-C timing.
    if (writerEditBeforeWrite) {
      await applyWriterEdit();
    }
    await expect(
      collab.agentEdit().write(
        {
          command: "create",
          file,
          documentId,
          content: "# Agent replacement",
          overwrite: true,
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    if (!writerEditBeforeWrite) await applyWriterEdit();
  }

  async function seedDestructivePush(
    responseId: string,
    documentId: DocumentId = ALPHA_ID,
    replace = false,
  ): Promise<string> {
    await persistence.lifecycle.ensureDocument(documentId);
    await liveCoordinator.withDocument(documentId, async (doc) => {
      const before = Y.encodeStateVector(doc);
      model.insertBlocks(
        toDocHandle(doc),
        null,
        markupCodec.parse("Writer captured body.\n\nSurvivor."),
      );
      await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    const context = { sessionId: THREAD_ID, threadId: THREAD_ID, turnId: TURN_ID, responseId };
    const file = documentId === ALPHA_ID ? "alpha.md" : "beta.md";
    await collab
      .agentEdit()
      .write({ command: "read", file, documentId }, { ...context, responseId: undefined });
    const branch = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
    const doomed = model.getBlocks(toDocHandle(branch.doc))[0];
    if (!doomed) throw new Error("draft block missing before destructive push");
    model.deleteBlock(toDocHandle(branch.doc), doomed);
    if (replace) {
      model.insertBlocks(toDocHandle(branch.doc), null, markupCodec.parse("Agent replacement."));
    }
    const committed = await branchCoordinator.commitSyncFromDoc({
      branchId: branch.branchId,
      sourceDoc: branch.doc,
      expectedGeneration: branch.generation,
      source: "agent",
      actorUserId: null,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      wId: null,
      updateMeta: null,
    });
    branch.doc.destroy();
    if (!committed) throw new Error("destructive draft edit did not commit");
    await liveCoordinator.withDocument(documentId, async (doc) => {
      const block = model.getBlocks(toDocHandle(doc))[0];
      if (!block) throw new Error("live writer block missing");
      const before = Y.encodeStateVector(doc);
      model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, "Writer recent: ");
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    return branch.branchId;
  }

  /** Stages real ProseMirror reconciliation shapes for durable settlement regressions. */
  async function seedMatrixPush(input: {
    responseId: string;
    initialMarkdown: string;
    steps: readonly MatrixDraftStep[];
  }): Promise<string> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      let before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, input.initialMarkdown);
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      for (const step of input.steps.filter((candidate) => candidate.source === "writer")) {
        before = Y.encodeStateVector(doc);
        if (step.remint) remintMarkdown(doc, step.markdown);
        else replaceMarkdown(doc, step.markdown);
        await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
          origin: `human:${USER_ID}`,
          seq: 0,
        });
      }
    });
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId: input.responseId,
    };
    await collab
      .agentEdit()
      .write(
        { command: "read", file: "alpha.md", documentId: ALPHA_ID },
        { ...context, responseId: undefined },
      );
    const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    try {
      for (const step of input.steps.filter((candidate) => candidate.source === "agent")) {
        const beforeStateVector = Y.encodeStateVector(branch.doc);
        const priorBlock = model.getBlocks(toDocHandle(branch.doc))[0];
        const source = priorBlock ? model.getVisibleContentLineage(priorBlock)[0] : undefined;
        const inputRevision = [...Y.encodeStateVector(branch.doc)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (step.transientInsertDelete !== undefined) {
          branch.doc.transact(() => {
            const fragment = branch.doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
            const paragraph = new Y.XmlElement("paragraph");
            paragraph.push([new Y.XmlText(step.transientInsertDelete)]);
            fragment.push([paragraph]);
            fragment.delete(fragment.length - 1, 1);
          });
        } else if (step.remint) remintMarkdown(branch.doc, step.markdown);
        else replaceMarkdown(branch.doc, step.markdown);
        const replacement = markupCodec.parse(step.markdown).blocks[0];
        const semanticEditIr = step.certifiedCarry
          ? (() => {
              if (!priorBlock || !source || !replacement) {
                throw new Error("certified matrix carry requires one source and replacement block");
              }
              if (source.length !== replacement.textContent.length) {
                throw new Error("certified matrix carry must preserve length");
              }
              return {
                version: 1 as const,
                documentId: ALPHA_ID,
                inputRevision: inputRevision as never,
                scope: [source],
                intent: {
                  kind: "mappedEdits" as const,
                  edits: [
                    {
                      edit: {
                        documentId: ALPHA_ID,
                        file: "alpha.md",
                        kind: "block" as const,
                        block: priorBlock,
                        replacement,
                      },
                      outputRuns: [
                        {
                          kind: "preserved" as const,
                          source,
                          output: { from: 0, to: source.length },
                        },
                      ],
                    },
                  ],
                },
                deleted: [source],
              };
            })()
          : undefined;
        if (semanticEditIr) {
          createSemanticProvenanceWriter().writeCertifiedFacts(
            toDocHandle(branch.doc),
            semanticEditIr,
            beforeStateVector,
          );
        }
        const committed = await branchCoordinator.commitSyncFromDoc({
          branchId: branch.branchId,
          sourceDoc: branch.doc,
          expectedGeneration: branch.generation,
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
          semanticEditIr,
        });
        if (!committed) throw new Error(`matrix ${step.source} step did not commit`);
      }
      return branch.branchId;
    } finally {
      branch.doc.destroy();
    }
  }

  async function seedPendingDependencyPush(): Promise<string> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    const source = new Y.Doc({ gc: false });
    source.clientID = 424_242;
    const fragment = source.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const paragraph = new Y.XmlElement("paragraph");
    fragment.push([paragraph]);
    const parentUpdate = Y.encodeStateAsUpdate(source);
    const parentVector = Y.encodeStateVector(source);
    paragraph.push([new Y.XmlText("Agent pending birth.")]);
    const childUpdate = Y.encodeStateAsUpdate(source, parentVector);
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      Y.applyUpdate(doc, childUpdate);
      await persistence.journal.append(ALPHA_ID, childUpdate, {
        origin: `agent:${TURN_ID}`,
        actorTurnId: TURN_ID,
        seq: 0,
      });
      Y.applyUpdate(doc, parentUpdate);
      await persistence.journal.append(ALPHA_ID, parentUpdate, {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    source.destroy();
    await collab
      .agentEdit()
      .write(
        { command: "read", file: "alpha.md", documentId: ALPHA_ID },
        { sessionId: THREAD_ID, threadId: THREAD_ID, turnId: TURN_ID, responseId: undefined },
      );
    const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    const staged = await branchCoordinator.readBranch(branch.branchId, async (doc, snapshot) => {
      const stagedDoc = new Y.Doc({ gc: false });
      Y.applyUpdate(stagedDoc, Y.encodeStateAsUpdate(doc));
      return { doc: stagedDoc, generation: snapshot.generation };
    });
    try {
      const block = model.getBlocks(toDocHandle(staged.doc))[0];
      if (!block) throw new Error("pending-dependency draft block is unavailable");
      model.deleteBlock(toDocHandle(staged.doc), block);
      await branchCoordinator.commitSyncFromDoc({
        branchId: branch.branchId,
        sourceDoc: staged.doc,
        expectedGeneration: staged.generation,
        source: "agent",
        actorUserId: null,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: null,
        updateMeta: null,
      });
    } finally {
      staged.doc.destroy();
    }
    return branch.branchId;
  }

  async function seedWriterDocument(markdown: string, responseId: string): Promise<void> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, markdown);
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    await collab
      .agentEdit()
      .write(
        { command: "read", file: "alpha.md", documentId: ALPHA_ID },
        { sessionId: THREAD_ID, threadId: THREAD_ID, turnId: TURN_ID, responseId },
      );
  }

  async function compactMixedProvenanceTwice(): Promise<{
    retainedUpdateCount: number;
    warmProvenance: string[];
    coldProvenance: string[];
    rebasedBranchProvenance: string[];
  }> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    return liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, "Agent-only passage.");
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `agent:${TURN_ID}`,
        actorTurnId: TURN_ID,
        seq: 0,
      });
      await persistence.journal.compact(ALPHA_ID, new Date("2100-01-01T00:00:00.000Z"));

      const firstBlock = model.getBlocks(toDocHandle(doc))[0];
      if (!firstBlock) throw new Error("compaction probe block is unavailable");
      const beforeWriter = Y.encodeStateVector(doc);
      model.applyTextEdit(toDocHandle(doc), firstBlock, { from: 0, to: 0 }, "Writer prefix. ");
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, beforeWriter), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      await persistence.journal.compact(ALPHA_ID, new Date("2100-01-01T00:00:00.000Z"));

      const warm = await persistence.journal.materializeDestructiveProvenance?.({
        docId: ALPHA_ID,
        before: toDocHandle(doc),
        afterCandidate: toDocHandle(doc),
      });
      const snapshot = await persistence.journal.read(ALPHA_ID);
      const coldDoc = new Y.Doc({ gc: false });
      if (snapshot.checkpoint) Y.applyUpdate(coldDoc, snapshot.checkpoint);
      for (const update of snapshot.updates) Y.applyUpdate(coldDoc, update.update);
      const cold = await persistence.journal.materializeDestructiveProvenance?.({
        docId: ALPHA_ID,
        before: toDocHandle(coldDoc),
        afterCandidate: toDocHandle(coldDoc),
      });
      coldDoc.destroy();

      const [checkpoint] = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, ALPHA_ID))
        .orderBy(desc(schema.documentYjsCheckpoints.id))
        .limit(1);
      if (!checkpoint) throw new Error("compaction probe checkpoint is unavailable");
      const authorityHead = await readDocumentAuthorityHead(db, ALPHA_ID);
      const replaced = await replaceDocumentAuthorityHeadGeneration(db, {
        documentId: ALPHA_ID,
        checkpointId: checkpoint.id,
        expectedGeneration: authorityHead.generation,
      });
      if (!replaced.ok) throw new Error(`compaction probe replacement failed: ${replaced.code}`);
      const rebased = await persistence.journal.materializeDestructiveProvenance?.({
        docId: ALPHA_ID,
        before: toDocHandle(doc),
        afterCandidate: toDocHandle(doc),
        fallbackProvenance: "agent",
      });
      const retainedUpdateCount = (
        await db
          .select()
          .from(schema.documentYjsUpdates)
          .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID))
      ).length;
      return {
        retainedUpdateCount,
        warmProvenance: [...new Set(warm?.before.map((run) => run.provenance) ?? [])].sort(),
        coldProvenance: [...new Set(cold?.before.map((run) => run.provenance) ?? [])].sort(),
        rebasedBranchProvenance: [
          ...new Set(rebased?.before.map((run) => run.provenance) ?? []),
        ].sort(),
      };
    });
  }

  async function seedAuthorityReplacementProbe(): Promise<number> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    return liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      let before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, "Restored base.");
      const baseSeq = await persistence.journal.append(
        ALPHA_ID,
        Y.encodeStateAsUpdate(doc, before),
        {
          origin: `agent:${TURN_ID}`,
          actorTurnId: TURN_ID,
          seq: 0,
        },
      );
      await persistence.journal.checkpoint(ALPHA_ID, Y.encodeStateAsUpdate(doc), baseSeq);
      const [checkpoint] = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, ALPHA_ID))
        .orderBy(desc(schema.documentYjsCheckpoints.id))
        .limit(1);
      if (!checkpoint) throw new Error("replacement probe checkpoint is unavailable");

      const block = model.getBlocks(toDocHandle(doc))[0];
      if (!block) throw new Error("replacement probe block is unavailable");
      before = Y.encodeStateVector(doc);
      model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, "Retired suffix. ");
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      return checkpoint.id;
    });
  }

  async function authorityReplacementProbeResult(generation: bigint): Promise<{
    coldMarkdown: string;
    currentGenerationUpdateCount: number;
  }> {
    const snapshot = await persistence.journal.read(ALPHA_ID);
    const coldDoc = new Y.Doc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(coldDoc, snapshot.checkpoint);
    for (const update of snapshot.updates) Y.applyUpdate(coldDoc, update.update);
    const coldMarkdown = serializeMarkdown(coldDoc);
    coldDoc.destroy();
    const currentGenerationUpdateCount = (
      await db
        .select()
        .from(schema.documentYjsUpdates)
        .where(
          and(
            eq(schema.documentYjsUpdates.documentId, ALPHA_ID),
            eq(schema.documentYjsUpdates.authorityGeneration, generation),
          ),
        )
    ).length;
    return { coldMarkdown, currentGenerationUpdateCount };
  }

  async function compactAfterAuthorityReplacement(): Promise<{
    coldMarkdown: string;
    currentGenerationUpdateCount: number;
  }> {
    const checkpointId = await seedAuthorityReplacementProbe();
    const authorityHead = await readDocumentAuthorityHead(db, ALPHA_ID);
    const replaced = await replaceDocumentAuthorityHeadGeneration(db, {
      documentId: ALPHA_ID,
      checkpointId,
      expectedGeneration: authorityHead.generation,
    });
    if (!replaced.ok) throw new Error(`replacement probe failed: ${replaced.code}`);
    await persistence.journal.compact(ALPHA_ID, new Date("2100-01-01T00:00:00.000Z"));
    return authorityReplacementProbeResult(replaced.generation);
  }

  async function compactWhileAuthorityReplacementWaits(): Promise<{
    coldMarkdown: string;
    currentGenerationUpdateCount: number;
  }> {
    const checkpointId = await seedAuthorityReplacementProbe();
    const authorityHead = await readDocumentAuthorityHead(db, ALPHA_ID);
    let releaseBlocker!: () => void;
    let blockerReady!: () => void;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerAcquired = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await lockDocumentMutation(tx, ALPHA_ID);
      blockerReady();
      await blockerRelease;
    });
    await blockerAcquired;

    async function waitForAdvisoryLockWaiters(expected: number): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND NOT granted
        `);
        if ((row?.waiting ?? 0) >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`expected ${expected} waiting document mutation locks`);
    }

    const compact = persistence.journal.compact(ALPHA_ID, new Date("2100-01-01T00:00:00.000Z"));
    let replacement: ReturnType<typeof replaceDocumentAuthorityHeadGeneration> | undefined;
    try {
      await waitForAdvisoryLockWaiters(1);
      replacement = replaceDocumentAuthorityHeadGeneration(db, {
        documentId: ALPHA_ID,
        checkpointId,
        expectedGeneration: authorityHead.generation,
      });
      await waitForAdvisoryLockWaiters(2);
    } finally {
      releaseBlocker();
      await blocker;
    }
    if (!replacement) {
      throw new Error("durable authority head generation replacement did not enter the lock queue");
    }
    const [, replaced] = await Promise.all([compact, replacement]);
    if (!replaced.ok) throw new Error(`replacement probe failed: ${replaced.code}`);
    return authorityReplacementProbeResult(replaced.generation);
  }

  async function seedLiveCertifiedCarry(input: {
    initialMarkdown: string;
    carriedMarkdown: string | readonly string[];
    responseId: string;
  }): Promise<string> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      let before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, input.initialMarkdown);
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      const carries = Array.isArray(input.carriedMarkdown)
        ? input.carriedMarkdown
        : [input.carriedMarkdown];
      for (const markdown of carries) {
        const block = model.getBlocks(toDocHandle(doc))[0];
        const source = block ? model.getVisibleContentLineage(block)[0] : undefined;
        const replacement = markupCodec.parse(markdown).blocks[0];
        if (!block || !source || !replacement || source.length !== replacement.textContent.length) {
          throw new Error("live certified carry requires one length-preserving block");
        }
        before = Y.encodeStateVector(doc);
        remintMarkdown(doc, markdown);
        const ir = {
          version: 1 as const,
          documentId: ALPHA_ID,
          inputRevision: "fixture-revision" as never,
          scope: [source],
          deleted: [source],
          intent: {
            kind: "mappedEdits" as const,
            edits: [
              {
                edit: {
                  documentId: ALPHA_ID,
                  file: "alpha.md",
                  kind: "block" as const,
                  block,
                  replacement,
                },
                outputRuns: [
                  {
                    kind: "preserved" as const,
                    source,
                    output: { from: 0, to: source.length },
                  },
                ],
              },
            ],
          },
        };
        createSemanticProvenanceWriter().writeCertifiedFacts(toDocHandle(doc), ir, before);
        await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
          origin: `agent:${TURN_ID}`,
          actorTurnId: TURN_ID,
          seq: 0,
        });
      }
    });
    await collab.agentEdit().write(
      { command: "read", file: "alpha.md", documentId: ALPHA_ID },
      {
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: input.responseId,
      },
    );
    const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    return branch.branchId;
  }

  /** Runs an agent command through the certified semantic-mutation admission path. */
  async function stageCertifiedReplace(input: {
    responseId: string;
    find: string;
    content: string;
  }): Promise<string> {
    const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    await db
      .update(schema.documentBranches)
      .set({ pushPolicy: "manual" })
      .where(eq(schema.documentBranches.id, branch.branchId));
    branch.doc.destroy();
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId: input.responseId,
    };
    await expect(
      collab.agentEdit().write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: input.find,
          content: input.content,
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      collab.finalizeResponseCommit(input.responseId, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toMatchObject({ status: "committed" });
    return branch.branchId;
  }

  async function seedCheckpointRestoredExplicitDelete(responseId: string): Promise<string> {
    const restored = "Explicit restored writer root.";
    const branchId = await seedLiveCertifiedCarry({
      responseId,
      initialMarkdown: restored,
      carriedMarkdown: restored,
    });
    const state = await liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
      Y.encodeStateAsUpdate(doc),
    );
    const upToSeq = await persistence.store.latestUpdateSeq(ALPHA_ID);
    const checkpointId = Number(
      await persistence.store.createCheckpoint(
        ALPHA_ID,
        state,
        "oracle-explicit-restoration",
        upToSeq,
      ),
    );
    const authorityHead = await readDocumentAuthorityHead(db, ALPHA_ID);
    const replaced = await replaceDocumentAuthorityHeadGeneration(db, {
      documentId: ALPHA_ID,
      checkpointId,
      expectedGeneration: authorityHead.generation,
    });
    if (!replaced.ok) throw new Error(`checkpoint restore failed: ${replaced.code}`);

    // Recreate the carried prose after the generation replacement as an explicit
    // restoration of the pre-carry writer root, not as fresh agent ancestry.
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const priorBlock = model.getBlocks(toDocHandle(doc))[0];
      const source = priorBlock ? model.getVisibleContentLineage(priorBlock)[0] : undefined;
      const fact = doc
        .getArray<{
          target: { clientID: number; clock: number; length: number };
          root: { clientID: number; clock: number; length: number };
        }>(PROVENANCE_TARGETS_TYPE)
        .toArray()
        .find(
          ({ target }) =>
            source &&
            target.clientID === source.clientID &&
            target.clock <= source.clock &&
            target.clock + target.length >= source.clock + source.length,
        );
      const replacement = markupCodec.parse(restored).blocks[0];
      if (!priorBlock || !source || !fact || !replacement) {
        throw new Error("carried checkpoint root is unavailable for restoration");
      }
      const [installedCheckpoint] = await db
        .select({ manifest: schema.documentYjsCheckpoints.attributionManifest })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, ALPHA_ID))
        .orderBy(desc(schema.documentYjsCheckpoints.id))
        .limit(1);
      const manifest = installedCheckpoint?.manifest as {
        attributions?: Array<{
          range: { clientID: number; clock: number; length: number };
        }>;
      };
      if (
        !manifest.attributions?.some(
          ({ range }) =>
            range.clientID === fact.root.clientID &&
            range.clock <= fact.root.clock &&
            range.clock + range.length >= fact.root.clock + fact.root.length,
        )
      ) {
        throw new Error(
          `checkpoint omitted carried writer root ${JSON.stringify(fact.root)} from ${JSON.stringify(manifest.attributions?.map(({ range }) => range))}`,
        );
      }
      const before = Y.encodeStateVector(doc);
      remintMarkdown(doc, restored);
      createSemanticProvenanceWriter().writeCertifiedFacts(
        toDocHandle(doc),
        {
          version: 1,
          documentId: ALPHA_ID,
          inputRevision: "fixture-revision" as never,
          scope: [source],
          deleted: [source],
          intent: {
            kind: "mappedEdits",
            edits: [
              {
                edit: {
                  documentId: ALPHA_ID,
                  file: "alpha.md",
                  kind: "block",
                  block: priorBlock,
                  replacement,
                },
                outputRuns: [
                  {
                    kind: "restoration",
                    root: fact.root,
                    payload: restored,
                    output: { from: 0, to: source.length },
                  },
                ],
              },
            ],
          },
        },
        before,
      );
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `agent:${TURN_ID}`,
        actorTurnId: TURN_ID,
        seq: 0,
      });
    });
    await collab.agentEdit().write(
      { command: "read", file: "alpha.md", documentId: ALPHA_ID },
      {
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
      },
    );
    void branchId;
    return stageCertifiedReplace({ responseId, find: restored, content: "" });
  }

  async function seedSelectivePush() {
    await collab.writeDocument({
      documentId: ALPHA_ID,
      markdown: "Selective base.",
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    await collab
      .agentEdit()
      .write(
        { command: "read", file: "alpha.md", documentId: ALPHA_ID },
        { sessionId: THREAD_ID, threadId: THREAD_ID, turnId: TURN_ID, responseId: undefined },
      );
    const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    const last = model.getBlocks(toDocHandle(branch.doc)).at(-1) ?? null;
    model.insertBlocks(toDocHandle(branch.doc), last, markupCodec.parse("Selected addition."));
    const committed = await branchCoordinator.commitSyncFromDoc({
      branchId: branch.branchId,
      sourceDoc: branch.doc,
      expectedGeneration: branch.generation,
      source: "agent",
      actorUserId: null,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      wId: null,
      updateMeta: null,
    });
    branch.doc.destroy();
    if (!committed) throw new Error("selective draft edit did not commit");
    const [row] = await db
      .select({ id: schema.branchWriteJournal.id })
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.status, "active"));
    if (!row) throw new Error("selective journal row missing");
    return { branchId: branch.branchId, journalId: row.id };
  }

  async function branchesByKind(kind: "thread_peer" | "work_draft") {
    return db.select().from(schema.documentBranches).where(eq(schema.documentBranches.kind, kind));
  }

  async function markdownByKind(kind: "thread_peer" | "work_draft") {
    const rows = await branchesByKind(kind);
    return Promise.all(
      rows
        .sort((left, right) => left.documentId.localeCompare(right.documentId))
        .map((row) => branchCoordinator.readBranch(row.id, async (doc) => serializeMarkdown(doc))),
    );
  }

  return {
    get failSecondJournalInsert() {
      return state.failSecondJournalInsert;
    },
    set failSecondJournalInsert(value: boolean) {
      state.failSecondJournalInsert = value;
      journalInsertCount = 0;
    },
    seedAndStage,
    seedAndStageDestructive,
    seedProbeTimelineSweep: (responseId: string, documentId: DocumentId = ALPHA_ID) =>
      seedAndStageDestructive(
        responseId,
        documentId,
        true,
        "Alpha base.\n\n---\n\nWriter block.\n\n---\n\nGamma.",
        2,
        true,
      ),
    seedProbeTimelineAfterRead: (responseId: string, documentId: DocumentId = ALPHA_ID) =>
      seedAndStageDestructive(
        responseId,
        documentId,
        true,
        "Alpha base.\n\n---\n\nWriter block.\n\n---\n\nGamma.",
        2,
        true,
      ),
    noticeRecordAttempts: () => noticeRecordAttempts,
    set failNoticeRecording(value: boolean) {
      noticeState.fail = value;
    },
    seedDestructivePush,
    seedMatrixPush,
    seedPendingDependencyPush,
    seedWriterDocument,
    compactMixedProvenanceTwice,
    compactAfterAuthorityReplacement,
    compactWhileAuthorityReplacementWaits,
    seedLiveCertifiedCarry,
    stageCertifiedReplace,
    seedCheckpointRestoredExplicitDelete,
    seedSelectivePush,
    crossWorkProbeFixture: () => ({
      db,
      schema,
      persistence,
      liveCoordinator,
      collab,
      branchStore,
      branchCoordinator,
      realBranchPush,
      trailDelivery,
      hocuspocus,
      model,
      markupCodec,
      agentEditCodec,
      deliveredEvents,
    }),
    pollTrails: () => trailDelivery.drain(),
    failNextTrailRetry() {
      failNextTrailRetry = true;
    },
    failAllTrailRetries() {
      failAllTrailRetries = true;
    },
    exhaustionFences: () => [...fences],
    workRows: () => db.select().from(schema.turnTrailWork),
    async branchGeneration(branchId: string) {
      const [branch] = await db
        .select({ generation: schema.documentBranches.generation })
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, branchId));
      if (!branch) throw new Error("missing branch");
      return branch.generation;
    },
    async stageAnotherDestructiveEdit(branchId: string) {
      const staged = await branchCoordinator.readBranch(branchId, async (doc, snapshot) => {
        const stagedDoc = new Y.Doc({ gc: false });
        Y.applyUpdate(stagedDoc, Y.encodeStateAsUpdate(doc));
        return { doc: stagedDoc, generation: snapshot.generation };
      });
      try {
        const doc = staged.doc;
        const block = model.getBlocks(toDocHandle(doc))[0];
        if (!block) throw new Error("draft block missing before subsequent edit");
        model.deleteBlock(toDocHandle(doc), block);
        await branchCoordinator.commitSyncFromDoc({
          branchId,
          sourceDoc: doc,
          expectedGeneration: staged.generation,
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
        });
      } finally {
        staged.doc.destroy();
      }
    },
    setPushPolicy: (pushPolicy: "auto" | "manual") =>
      db.update(schema.documentBranches).set({ pushPolicy }),
    markTurnError: () =>
      db.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, TURN_ID)),
    rollbackResponse: (responseId: string) =>
      collab.finalizeResponseRollback(responseId, { threadId: THREAD_ID, turnId: TURN_ID }),
    addLiveDependency: () =>
      liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
        const block = model.getBlocks(toDocHandle(doc))[0];
        if (!block) throw new Error("live dependency block missing");
        const before = Y.encodeStateVector(doc);
        model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, "Writer follow-up: ");
        await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
          origin: `human:${USER_ID}`,
          seq: 0,
        });
      }),
    autoPush: (branchId: string) =>
      realBranchPush.pushToLive({ branchId, overlapPolicy: "apply_and_trail" }),
    recoverPendingLiveSettlements: () => realBranchPush.recoverPendingLiveSettlements(),
    async probeStaleSettlementClaim(claim: {
      token: string;
      epoch: number;
      kind: "warm" | "recovery";
      leaseExpiresAt: Date;
    }) {
      const [row] = await db.select().from(schema.branchPushSettlementOutbox);
      if (!row) throw new Error("settlement row is unavailable");
      let completionCallbackRan = false;
      const renewed = await durableSettlementStore.renewClaim({
        pushId: row.pushId,
        claim,
      });
      const failureRecorded = await durableSettlementStore.recordFailure({
        pushId: row.pushId,
        claim,
        error: "stale actor A failure",
      });
      const completion = await durableSettlementStore.withCompletionFence(
        {
          pushId: row.pushId,
          documentId: row.documentId,
          claim,
          settledJoinVersion: row.settledJoinVersion ?? row.joinVersion,
        },
        () => {
          completionCallbackRan = true;
          return "applied";
        },
      );
      return { renewed, failureRecorded, completion, completionCallbackRan };
    },
    async handoffPendingSettlement() {
      const [row] = await db.select().from(schema.branchPushSettlementOutbox);
      if (!row?.claimToken || !row.claimKind || !row.claimedAt || !row.leaseExpiresAt) {
        throw new Error("owned settlement claim is unavailable for handoff");
      }
      return settlementStore.handoffClaim({
        pushId: row.pushId,
        claim: {
          token: row.claimToken,
          epoch: Number(row.claimEpoch),
          kind: row.claimKind,
          leaseExpiresAt: row.leaseExpiresAt,
        },
      });
    },
    async attemptSnapshotReplacement() {
      const [checkpoint] = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, ALPHA_ID))
        .limit(1);
      if (!checkpoint) throw new Error("durable authority checkpoint is unavailable");
      const authorityHead = await readDocumentAuthorityHead(db, ALPHA_ID);
      return replaceDocumentAuthorityHeadGeneration(db, {
        documentId: ALPHA_ID,
        checkpointId: checkpoint.id,
        expectedGeneration: authorityHead.generation,
      });
    },
    async attemptDivergentReplicationAdmission() {
      const base = new Y.Doc({ gc: false });
      const fragment = base.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      const root = (() => {
        const paragraph = new Y.XmlElement("paragraph");
        const text = new Y.XmlText("a");
        paragraph.push([text]);
        fragment.push([paragraph]);
        const id = (text as unknown as { _start: { id: { client: number; clock: number } } })._start
          .id;
        return { clientID: id.client, clock: id.clock, length: 1 };
      })();
      const carry = (value: string) => {
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
        doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(0, 1);
        const paragraph = new Y.XmlElement("paragraph");
        const text = new Y.XmlText(value);
        paragraph.push([text]);
        doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).push([paragraph]);
        const id = (text as unknown as { _start: { id: { client: number; clock: number } } })._start
          .id;
        appendProvenanceFacts(doc, {
          targets: [
            {
              version: 1,
              target: { clientID: id.client, clock: id.clock, length: 1 },
              root,
            },
          ],
        });
        return doc;
      };
      const target = carry("t");
      const source = carry("s");
      const before = Y.encodeStateAsUpdate(target);
      let journaled = false;
      try {
        await replicateFrozenIdentity({
          source: { documentId: ALPHA_ID, doc: source },
          target: { documentId: ALPHA_ID, generation: 1n, doc: target },
          plan: { kind: "wholeDocument" },
          admit: async ({ update }) => {
            journaled = true;
            Y.applyUpdate(target, update);
            return { sequence: 1n, joined: 0 };
          },
        });
        return { rejected: false, journaled, applied: true };
      } catch (cause) {
        return {
          rejected:
            cause instanceof Error &&
            cause.message.includes("One provenance root unit cannot have two visible targets"),
          journaled,
          applied: !Buffer.from(Y.encodeStateAsUpdate(target)).equals(Buffer.from(before)),
        };
      } finally {
        base.destroy();
        target.destroy();
        source.destroy();
      }
    },
    destroyWarmState() {
      for (const doc of hocuspocus.documents.values()) doc.destroy();
      hocuspocus.documents.clear();
      hocuspocus.broadcasts.length = 0;
    },
    selectivePush: (input: { branchId: string; journalId: number }) =>
      realBranchPush.pushSelectedToLive({
        branchId: input.branchId,
        journalIds: [input.journalId],
      }),
    reverseTurn: (direction: "undo" | "redo") =>
      collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction,
        actor: { type: "user", userId: USER_ID },
      }),
    liveMarkdown: (documentId: DocumentId) =>
      liveCoordinator.withDocument(documentId, async (doc) => serializeMarkdown(doc)),
    pushRows: () => db.select().from(schema.pushLineage),
    liveUpdateCount: async () => (await db.select().from(schema.documentYjsUpdates)).length,
    activePushJournalCount: async () =>
      (
        await db
          .select()
          .from(schema.branchWriteJournal)
          .where(eq(schema.branchWriteJournal.status, "active"))
      ).length,
    async makeJournalOwnershipMixed() {
      const [owned] = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.status, "active"));
      if (!owned) throw new Error("missing owned journal row");
      await db.insert(schema.branchWriteJournal).values({
        branchId: owned.branchId,
        generation: owned.generation,
        wId: owned.wId,
        source: owned.source,
        threadId: owned.threadId,
        turnId: null,
        actorUserId: owned.actorUserId,
        updateData: owned.updateData,
        draftBaseUpdateSeq: owned.draftBaseUpdateSeq,
        updateMeta: owned.updateMeta,
      });
    },
    async makeJournalOwnershipNull() {
      await db
        .update(schema.branchWriteJournal)
        .set({ turnId: null })
        .where(eq(schema.branchWriteJournal.status, "active"));
      await db.delete(schema.turnTrailWork);
    },
    hardDeleteDocument: (documentId: DocumentId) =>
      db.delete(schema.documents).where(eq(schema.documents.id, documentId)),
    async hardDeleteThread() {
      await db.delete(schema.turns).where(eq(schema.turns.threadId, THREAD_ID));
      await db.delete(schema.threads).where(eq(schema.threads.id, THREAD_ID));
    },
    commit: (responseId: string) =>
      collab.finalizeResponseCommit(responseId, { threadId: THREAD_ID, turnId: TURN_ID }),
    afterCommitEffects: () => ({
      autoPushSchedules: [...autoPushSchedules].sort(),
      branchBroadcasts: [...branchBroadcasts].sort(),
      watermarkCommits: [...watermarkCommits].sort(),
    }),
    waitForAutoPushes: async () => {
      for (let attempt = 0; autoPushPromises.length === 0 && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await Promise.all(autoPushPromises);
    },
    openRoomIds: () => [...hocuspocus.documents.keys()].sort(),
    liveRoomBroadcasts: () => [...hocuspocus.broadcasts],
    stagedUpdates: (responseId: string) => [
      collab.agentEdit().hasResponseDocument(responseId, ALPHA_ID) ? [ALPHA_ID] : [],
      collab.agentEdit().hasResponseDocument(responseId, BETA_ID) ? [BETA_ID] : [],
    ],
    pendingWatermarkDocuments: () => [...pendingWatermarks].sort(),
    responseEvents: (responseId: string) =>
      events
        .filter((event) => event.payload.responseId === responseId)
        .map((event) => ({
          transition: event.name.replace("response_committer.", ""),
          phase: event.payload.phase,
        })),
    responseJournalRows: () =>
      db
        .select()
        .from(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.threadId, THREAD_ID),
            eq(schema.branchWriteJournal.turnId, TURN_ID),
          ),
        ),
    noticeRows: () => db.select().from(schema.pendingNotices),
    async trailRows() {
      return {
        shells: await db.select().from(schema.changeTrailShells),
        details: await db.select().from(schema.changeTrailDocumentDetails),
        outbox: await db.select().from(schema.changeTrailDeliveryOutbox),
      };
    },
    threadPeerMarkdown: () => markdownByKind("thread_peer"),
    workDraftMarkdown: () => markdownByKind("work_draft"),
    async databaseBranchHashes() {
      return databaseBranchHashes();
    },
    async captureState() {
      return {
        databaseBranchHashes: await this.databaseBranchHashes(),
        threadPeerMarkdown: await this.threadPeerMarkdown(),
        workDraftMarkdown: await this.workDraftMarkdown(),
      };
    },
    async expectSuccessfulCommit(responseId: string) {
      expect(await this.responseJournalRows()).toHaveLength(2);
      expect(await databaseBranchHashes()).not.toEqual(preCommitBranchHashes);
      expect(await this.threadPeerMarkdown()).toEqual([
        expect.stringContaining("Agent alpha."),
        expect.stringContaining("Agent beta."),
      ]);
      expect(await this.workDraftMarkdown()).toEqual([
        expect.stringContaining("Agent alpha."),
        expect.stringContaining("Agent beta."),
      ]);
      expect(this.stagedUpdates(responseId)).toEqual([[], []]);
      expect(this.responseEvents(responseId)).toContainEqual({
        transition: "closed",
        phase: "closed",
      });
      expect(branchBroadcasts).toHaveLength(2);
      expect(autoPushSchedules).toHaveLength(2);
      expect(watermarkCommits).toHaveLength(2);
      expect(this.openRoomIds()).toEqual([ALPHA_ID, BETA_ID]);
    },
  };

  async function databaseBranchHashes() {
    const rows = await db.select().from(schema.documentBranches);
    return rows
      .map((row) => ({
        id: row.id,
        state: Buffer.from(row.state).toString("base64"),
        stateVector: Buffer.from(row.stateVector).toString("base64"),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

function serializeMarkdown(doc: Y.Doc): string {
  const blocks = model.getBlocks(toDocHandle(doc));
  return blocks.length === 0 ? "" : markupCodec.serialize(model.projectBlocks(toDocHandle(doc)));
}

function replaceMarkdown(doc: Y.Doc, markdown: string): void {
  const parsed = markupCodec.parse(markdown);
  const replacement = documentSchema.node("doc", null, parsed.blocks);
  updateYFragment(doc, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), replacement, {
    mapping: new Map(),
    isOMark: new Map(),
  });
}

function remintMarkdown(doc: Y.Doc, markdown: string): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    replaceMarkdown(doc, markdown);
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
