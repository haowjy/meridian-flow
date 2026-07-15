/** Focused real-Postgres harness for change-trail durability tests. */
import {
  createAgentEditCodec,
  digestRenderedContent,
  type ObservationSnapshotStore,
  snapshotBlocks,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { DocumentAuthorityId, ResponseCausalCutId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
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
const { createDrizzleBranchPushStore } = await import("../adapters/drizzle-branch-push.js");
const { createChangeTrailWorker } = await import("../adapters/change-trail-worker.js");
const { createDrizzleChangeTrailPersistence } = await import(
  "../adapters/drizzle-change-trails.js"
);
const { createDrizzleBranchStore } = await import("../adapters/drizzle-branches.js");
const { createDrizzleCollabPersistence } = await import("../adapters/drizzle-journal.js");
const { createHocuspocusCoordinator } = await import("../adapters/hocuspocus-coordinator.js");
const { createFacade } = await import("../composition.js");
const { createBranchConcurrentJournalWatermarks } = await import("../domain/branch-agent-edit.js");
const { createBranchCoordinator } = await import("../domain/branch-coordinator.js");
const { createBranchCriticalSections } = await import("../domain/branch-critical-sections.js");
const { createBranchPullService } = await import("../domain/branch-pulls.js");
const { createBranchPushService } = await import("../domain/branch-push.js");
const { createSemanticProvenanceWriter } = await import("../domain/provenance.js");

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
  afterDurableCommit?: (input: {
    documentIds: readonly DocumentId[];
    appendWriterPrefix(documentId: DocumentId, prefix: string): Promise<void>;
  }) => Promise<void>;
};

export type MatrixDraftStep = {
  source: "writer" | "agent";
  markdown: string;
  remint?: boolean;
  /** Certifies a length-preserving structural re-mint as one preserved root run. */
  certifiedCarry?: boolean;
};

export function createHarness(options: ChangeTrailHarnessOptions = {}) {
  const persistence = createDrizzleCollabPersistence(db);
  const hocuspocus = fakeHocuspocus();
  const observationSnapshots = observationStoreFor(hocuspocus.documents);
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
  const branchPushStore = createDrizzleBranchPushStore(
    db,
    { model, codec: markupCodec },
    changeTrails,
    notices,
  );

  const realBranchPush = createBranchPushService({
    branchStore,
    criticalSections: branchCriticalSections,
    pushStore: branchPushStore,
    branchCoordinator,
    journal: persistence.journal,
    liveCoordinator,
    model,
    codec: markupCodec,
    notices,
    resolveDocumentTitle: async (documentId) => (documentId === ALPHA_ID ? "alpha" : "beta"),
    hooks: options.afterDurableCommit
      ? {
          afterDurableCommit: async (documentIds) =>
            options.afterDurableCommit?.({
              documentIds,
              async appendWriterPrefix(documentId, prefix) {
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
              },
            }),
        }
      : undefined,
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
  const collab = createFacade({
    ...persistence,
    observationSnapshots,
    coordinator: liveCoordinator,
    hocuspocus: () => hocuspocus as never,
    bindHocuspocus() {},
    liveLineage: {
      listLiveDocumentsForTurn: async () => [],
      listEditedDocumentsForTurn: async () => [],
      getTurnReceiptChip: async () => null,
    } as never,
    threads: { findById: async () => ({ id: THREAD_ID }) },
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
    branchPushStore,
    concurrentJournalWatermarks: watermarks,
    documentUriResolver: async (documentId) =>
      documentId === ALPHA_ID ? "manuscript/alpha.md" : "manuscript/beta.md",
    resolveWorkWriteMode: async () => "draft",
    commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(db, operation),
  });

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
    branchBroadcasts.length = 0;
    watermarkCommits.length = 0;
    autoPushSchedules.length = 0;
    hocuspocus.broadcasts.length = 0;
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
  }

  async function seedAndStageDestructive(
    responseId: string,
    documentId: DocumentId = ALPHA_ID,
    journalWriterEdit = true,
    markdown = "Alpha base.\n\nWriter block.",
    writerBlockIndex = 1,
    writerEditBeforeWrite = false,
    observeWriterEdit = false,
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
    if (writerEditBeforeWrite && !observeWriterEdit) observationSnapshots.capture(responseId);
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
    // The probe edit landed after the response's read observation but before the
    // destructive tool call. Journaled fixtures retain their older phase-C timing.
    if (writerEditBeforeWrite) {
      await applyWriterEdit();
      if (observeWriterEdit) observationSnapshots.capture(responseId);
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
        if (step.remint) remintMarkdown(branch.doc, step.markdown);
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
    seedProbeTimelineObserved: (responseId: string, documentId: DocumentId = ALPHA_ID) =>
      seedAndStageDestructive(
        responseId,
        documentId,
        true,
        "Alpha base.\n\n---\n\nWriter block.\n\n---\n\nGamma.",
        2,
        true,
        true,
      ),
    noticeRecordAttempts: () => noticeRecordAttempts,
    set failNoticeRecording(value: boolean) {
      noticeState.fail = value;
    },
    seedDestructivePush,
    seedMatrixPush,
    seedWriterDocument,
    seedLiveCertifiedCarry,
    stageCertifiedReplace,
    seedSelectivePush,
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
      [...collab.agentEdit().bufferedUpdatesForDoc(responseId, ALPHA_ID)],
      [...collab.agentEdit().bufferedUpdatesForDoc(responseId, BETA_ID)],
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

function observationStoreFor(documents: Map<string, Y.Doc>): ObservationSnapshotStore & {
  capture(responseId: string): void;
} {
  const snapshots = new Map<string, Awaited<ReturnType<ObservationSnapshotStore["load"]>>>();
  const capture = (responseId: string) => {
    const documentEntries = [...documents.entries()].filter(([documentId]) =>
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(documentId),
    );
    const entries = documentEntries.flatMap(([documentId, document]) =>
      snapshotBlocks(toDocHandle(document), model, agentEditCodec).map((block) => ({
        documentId,
        clientID: block.clientID as number,
        clock: block.clock as number,
        value: {
          kind: "rendered" as const,
          digest: digestRenderedContent(block.renderedContent as string),
        },
      })),
    );
    const causalCuts = documentEntries.map(([documentId]) => ({
      id: crypto.randomUUID() as ResponseCausalCutId,
      version: 1 as const,
      documentId,
      authorityId: documentId as DocumentAuthorityId,
      generation: 1n,
      admittedThrough: 0n,
    }));
    snapshots.set(responseId, { responseId, entries, causalCuts });
  };
  return {
    capture,
    async seal(snapshot) {
      snapshots.set(snapshot.responseId, snapshot);
    },
    async load(responseId) {
      const existing = snapshots.get(responseId);
      if (existing !== undefined) return existing;
      capture(responseId);
      return snapshots.get(responseId) ?? null;
    },
  };
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
