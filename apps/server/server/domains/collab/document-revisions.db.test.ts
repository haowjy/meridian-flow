/** Revision identity across live rooms, Work peers, response settlement and rebinding. */

import { renderAgentEditResult, toDocHandle } from "@meridian/agent-edit/integration";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createDocumentRevisions } from "../context/index.js";
import { createLocalFileAccessChanges } from "../file-policy/index.js";
import { createDrizzleProjectWorkRepository } from "../projects/index.js";
import { createDrizzleThreadLock } from "../runtime/adapters/drizzle-thread-lock.js";
import { createDrizzleThreadRepository } from "../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchPullService } from "./domain/branch-pulls.js";
import { scopeBranchPeer } from "./domain/document-link-scope-doors.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import type { DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import { runResponseTransaction } from "./domain/response-transaction.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { createTestDocumentLinkScopes } from "./test-support/document-link-scopes.js";

async function fixture(
  db: Database,
  harnesses: Array<ReturnType<typeof createHarness>>,
  mode: "direct" | "draft",
  options: { links?: DocumentLinkScopes } = {},
) {
  const harness = createHarness(db);
  harnesses.push(harness);
  const f = harness.crossWorkProbeFixture();
  await db.update(schema.works).set({ aiWriteMode: mode }).where(eq(schema.works.id, WORK_ID));
  await f.persistence.lifecycle.ensureDocument(ALPHA_ID);
  await f.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
    const before = Y.encodeStateVector(doc);
    f.model.insertBlocks(
      toDocHandle(doc),
      null,
      f.markupCodec.parse("Opening paragraph.\n\nSurvivor."),
    );
    await f.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  });
  await f.branchStore.reconcileProjectManifest(PROJECT_ID);
  // The reads spell from the harness's scope, so their revisions compare with these.
  const links = options.links ?? f.links;
  const effective = scopeBranchPeer(
    createEffectiveDocumentReader({
      branches: f.branchStore,
      branchCoordinator: f.branchCoordinator,
      branchPulls: f.branchPulls,
      liveCoordinator: f.liveCoordinator,
      agentEdit: f.collab.agentEdit(),
      documents: f.runtime.markdownDocuments,
      model: f.runtime.model,
      codec: f.runtime.codec,
      links,
    }),
    links,
  );
  const revisions = createDocumentRevisions({
    threads: createDrizzleThreadRepository(db),
    availability: createDrizzleProjectContextAvailability(db),
    documents: effective,
    works: createDrizzleProjectWorkRepository({
      db,
      fileAccessChanges: createLocalFileAccessChanges(),
      projectionMutation: createTestWorkProjectionMutation(db),
    }),
    threadWorks: createDrizzleThreadWorksRepository(db),
  });
  const core = f.collab.agentEdit();
  const context = {
    threadId: THREAD_ID,
    sessionId: THREAD_ID,
    turnId: TURN_ID,
    grant: testFileGrant(
      mode === "direct"
        ? { kind: "live" }
        : { kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" },
    ),
  };
  const read = (responseId?: string) =>
    core.read({ file: "alpha.md", documentId: ALPHA_ID }, { ...context, responseId });
  const current = async () =>
    (await revisions.current({ threadId: THREAD_ID, documentIds: [ALPHA_ID] })).get(ALPHA_ID);
  async function writerDelete() {
    // This is the room owned by Hocuspocus, not the delayed markdown projection.
    const doc = f.hocuspocus.documents.get(ALPHA_ID);
    if (!doc) throw new Error("Fixture live room missing");
    const before = Y.encodeStateVector(doc);
    const block = f.model.getBlocks(toDocHandle(doc))[0];
    if (!block) throw new Error("Fixture writer paragraph missing");
    f.model.deleteBlock(toDocHandle(doc), block);
    await f.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  }
  async function stage(responseId: string) {
    await db.insert(schema.modelResponses).values({
      id: responseId as never,
      turnId: TURN_ID,
      sequence: 0,
      provider: "mock",
      model: "mock",
      requestMessageCount: 0,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });

    const outcome = await core.write(
      {
        command: "create",
        file: "alpha.md",
        documentId: ALPHA_ID,
        overwrite: true,
        content: "Agent revision.",
      },
      { ...context, responseId, createdDocument: false },
    );
    expect(outcome.isError, renderAgentEditResult(outcome.result)).toBe(false);
    return outcome;
  }
  return { ...f, core, read, current, stage, writerDelete, revisions, effective };
}

describe("document revisions (postgres and collab)", () => {
  const db = createTestDatabase();
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  beforeEach(() => resetDatabase(db));
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.cancelScheduledPulls();
  });
  afterAll(() => closeDatabase(db));

  for (const mode of ["direct", "draft"] as const) {
    it(`response-end write and staged read equal current in ${mode}; the earlier read does not`, async () => {
      const f = await fixture(db, harnesses, mode);
      const before = await f.read();
      await f.stage("00000000-0000-4000-8000-000000000892");
      const stagedRead = await f.read("00000000-0000-4000-8000-000000000892");
      const settled = await f.core.commitResponse("00000000-0000-4000-8000-000000000892");
      const revision = settled.documents[0]?.receipts[0]?.revision;
      expect(revision).toBe(stagedRead.revision);
      expect(revision).toBe(await f.current());
      expect(before.revision).not.toBe(revision);
    });
  }

  it("a pure writer deletion in the Hocuspocus room invalidates a live read", async () => {
    const f = await fixture(db, harnesses, "direct");
    const before = await f.read();
    await f.writerDelete();
    expect(await f.current()).not.toBe(before.revision);
  });

  it("a tree-only move changes the view revision, so compaction does not elide the stale read", async () => {
    const f = await fixture(db, harnesses, "direct", { links: createTestDocumentLinkScopes(db) });
    const doc = f.hocuspocus.documents.get(ALPHA_ID);
    if (!doc) throw new Error("Fixture live room missing");
    const before = Y.encodeStateVector(doc);
    const documentSchema = buildDocumentSchema();
    const link = documentSchema.marks.link.create({ href: "beta.md", ref: `doc:${BETA_ID}` });
    f.model.insertBlocks(toDocHandle(doc), null, {
      blocks: [documentSchema.node("paragraph", null, [documentSchema.text("Beta", [link])])],
    });
    await f.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
    const shown = await f.current();
    expect(shown).toMatch(/^y2:/);
    expect(await f.current()).toBe(shown);

    // Nothing in alpha changes; only where its link's target sits.
    await db
      .update(schema.documents)
      .set({ name: "gamma" })
      .where(eq(schema.documents.id, BETA_ID));
    expect(await f.current()).not.toBe(shown);
  });

  it("captures the apply token before a writer edit and receipt rewrite", async () => {
    const f = await fixture(db, harnesses, "direct");
    await f.read();
    await f.stage("00000000-0000-4000-8000-000000000893");
    let injected = false;
    // The live apply runs on a private copy inside the save transaction (D42);
    // a writer edit after it and before commit must not move the receipt.
    const committed = await f.core.commitResponse("00000000-0000-4000-8000-000000000893", {
      beforeTransactionCommit: async () => {
        injected = true;
        await f.writerDelete();
      },
    });
    expect(injected).toBe(true);
    const receipt = committed.documents[0]?.receipts[0];
    expect(receipt?.revision).toMatch(/^y2:/);
    expect(receipt?.revision).not.toBe(await f.current());
  });

  it("resolves a new Work source after rebind when its text differs", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.read();
    await f.stage("00000000-0000-4000-8000-000000000894");
    await f.core.commitResponse("00000000-0000-4000-8000-000000000894");
    const before = await f.read();
    const workB = "00000000-0000-4000-8000-000000000890" as WorkId;
    await db.insert(schema.works).values({
      id: workB,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Other draft",
      slug: "other-draft",
      aiWriteMode: "draft",
    });
    await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, workB);
    expect(await f.current()).not.toBe(before.revision);
    expect((await f.read()).revision).toBe(await f.current());
  });

  it("does not treat a deleted document's still-loaded room as a readable source", async () => {
    const f = await fixture(db, harnesses, "direct");
    expect((await f.read()).revision).toMatch(/^y2:/);
    await db
      .update(schema.documents)
      .set({ deletedAt: new Date() })
      .where(eq(schema.documents.id, ALPHA_ID));
    expect(f.hocuspocus.documents.has(ALPHA_ID)).toBe(true);
    expect(await f.current()).toBeNull();
  });

  it("PROBE3: current under the thread lock completes with a contending debounced pull", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.read();
    await f.writerDelete();
    const originalPull = f.branchCoordinator.pullFromDoc.bind(f.branchCoordinator);
    const originalRead = f.branchCoordinator.readBranch.bind(f.branchCoordinator);
    const draft = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    const workBranchId = draft.branchId;
    draft.doc.destroy();
    const contending = deferred();
    let scheduled = false;
    f.branchCoordinator.pullFromDoc = async (...args) => {
      if (scheduled && args[0] === workBranchId) contending.resolve();
      return originalPull(...args);
    };
    f.branchCoordinator.readBranch = async (id, callback) => {
      if (!scheduled && id === workBranchId) {
        scheduled = true;
        await f.writerDelete();
        runOutsideDrizzleTransaction(() => f.branchPulls.scheduleLivePull(ALPHA_ID));
        await contending.promise;
      }
      return originalRead(id, callback);
    };
    await createDrizzleThreadLock(db).withThreadLock(THREAD_ID, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const revision = await Promise.race([
          f.current(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("contended pull timed out")), 5000);
          }),
        ]);
        expect(revision).toMatch(/^y2:/);
      } finally {
        clearTimeout(timer);
      }
    });
    await f.branchPulls.flushLivePull(ALPHA_ID);
  }, 10000);

  it("current under the thread lock handles a cold manifest", async () => {
    const f = await fixture(db, harnesses, "draft");
    const manifest = await f.branchStore.ensureProjectManifest({ projectId: PROJECT_ID });
    manifest.doc.destroy();
    await db
      .update(schema.documents)
      .set({ deletedAt: new Date() })
      .where(eq(schema.documents.id, manifest.documentId));
    await createDrizzleThreadLock(db).withThreadLock(THREAD_ID, async () => {
      expect(await bounded(() => f.current())).toBeNull();
    });
  });

  it("a flush joining an older snapshot waits for a fresh committed pull", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.liveCoordinator.withDocument(ALPHA_ID, async (liveDoc) => {
      await f.branchStore.ensureWorkDraftBranch({ documentId: ALPHA_ID, workId: WORK_ID, liveDoc });
    });
    const before = await f.current();
    const captured = deferred();
    const release = deferred();
    const original = f.branchCoordinator.pullFromDoc.bind(f.branchCoordinator);
    let pause = true;
    f.branchCoordinator.pullFromDoc = async (...args) => {
      if (pause) {
        pause = false;
        captured.resolve();
        await release.promise;
      }
      return original(...args);
    };
    const older = f.branchPulls.flushLivePull(ALPHA_ID);
    const started = [older];
    try {
      await Promise.race([
        captured.promise,
        older.then(() => {
          throw new Error("Older pull completed without reaching its snapshot latch");
        }),
      ]);
      await f.writerDelete();
      f.branchPulls.scheduleLivePull(ALPHA_ID);
      const joined = f.branchPulls.flushLivePull(ALPHA_ID);
      started.push(joined);
      release.resolve();
      await Promise.all(started);
      const draft = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
      const blocks = f.model.getBlocks(toDocHandle(draft.doc)).length;
      draft.doc.destroy();
      await f.branchPulls.flushLivePull(ALPHA_ID);
      expect(blocks).toBe(1);
      expect(await f.current()).not.toBe(before);
    } finally {
      // A failed writer/assertion must not leave a root transaction paused across suite cleanup.
      release.resolve();
      await Promise.allSettled(started);
    }
  });

  it("concurrent live pulls for more documents than pooled connections all finish", async () => {
    const f = await fixture(db, harnesses, "draft");
    // The harness pool holds 4 connections. A pull that takes its live snapshot
    // while holding its root transaction needs a second one, so 8 at once
    // would hold every connection and wait forever.
    const documentIds = [
      ALPHA_ID,
      ...Array.from({ length: 7 }, () => crypto.randomUUID() as typeof ALPHA_ID),
    ];
    await bounded(() =>
      Promise.all(documentIds.map((documentId) => f.branchPulls.flushLivePull(documentId))),
    );
  });

  it("publishes a root-committed pull even when its caller response aborts", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.read();
    await f.writerDelete();
    const broadcasts: string[] = [];
    const coordinator = createBranchCoordinator({
      store: f.branchStore,
      onBranchUpdate: ({ branchId }) => broadcasts.push(branchId),
    });
    const pulls = createBranchPullService({
      outsideTransaction: runOutsideDrizzleTransaction,
      rootTransaction: (operation) => runInRootDrizzleTransaction(db, operation),
      liveCoordinator: f.liveCoordinator,
      branchCoordinator: coordinator,
      branches: f.branchStore,
    });
    await expect(
      runResponseTransaction(
        (operation) => runInDrizzleTransaction(db, operation),
        async () => {
          await pulls.pullThreadPeer({ documentId: ALPHA_ID, threadId: THREAD_ID });
          throw new Error("response aborted");
        },
      ),
    ).rejects.toThrow("response aborted");
    const peer = await f.branchStore.resolveThreadBranch(ALPHA_ID, THREAD_ID);
    const draft = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    expect(f.model.getBlocks(toDocHandle(peer.doc))).toHaveLength(1);
    expect(broadcasts).toEqual(expect.arrayContaining([peer.branchId, draft.branchId]));
    peer.doc.destroy();
    draft.doc.destroy();
  });

  it("a live manifest re-read observes its caller's uncommitted membership edit", async () => {
    const f = await fixture(db, harnesses, "draft");
    await runInDrizzleTransaction(db, async () => {
      await f.branchStore.recordManifestDocumentDeleted(ALPHA_ID);
      const membership = await bounded(() =>
        f.effective.resolveManifestMembership({ projectId: PROJECT_ID }),
      );
      expect(membership.members).not.toContain(ALPHA_ID);
    });
  });

  it("returns null when a document is removed from the Work manifest", async () => {
    const f = await fixture(db, harnesses, "draft");
    const before = await f.read();
    await f.effective.recordManifestDocumentDeleted(ALPHA_ID, {
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      workId: WORK_ID,
    });
    const membership = await f.effective.resolveManifestMembership({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
    });
    expect(membership.members).not.toContain(ALPHA_ID);
    expect(before.revision).toMatch(/^y2:/);
    expect(await f.current()).toBeNull();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("pull timed out")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
