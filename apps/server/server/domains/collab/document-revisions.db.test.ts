/** Revision identity across live rooms, Work peers, response settlement and rebinding. */

import { toDocHandle } from "@meridian/agent-edit/integration";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { requireLockedActiveWork } from "../../shared/work-lifecycle-lock.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createDocumentRevisions } from "../context/index.js";
import { createDrizzleProjectWorkRepository } from "../projects/index.js";
import { createDrizzleThreadLock } from "../runtime/adapters/drizzle-thread-lock.js";
import { createDrizzleThreadRepository } from "../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
import { threadExecutionContext } from "../threads/index.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchPullService } from "./domain/branch-pulls.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import { runResponseTransaction } from "./domain/response-transaction.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  db,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function fixture(mode: "direct" | "draft") {
  const harness = createHarness();
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
  const effective = createEffectiveDocumentReader({
    branches: f.branchStore,
    branchCoordinator: f.branchCoordinator,
    branchPulls: f.branchPulls,
    branchPush: f.branchPush,
    liveCoordinator: f.liveCoordinator,
    agentEdit: f.collab.agentEdit(),
    documents: f.runtime.markdownDocuments,
    model: f.runtime.model,
    codec: f.runtime.codec,
  });
  const revisions = createDocumentRevisions({
    threads: createDrizzleThreadRepository(db),
    availability: createDrizzleProjectContextAvailability(db),
    documents: effective,
    works: createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
      projectionMutation: createTestWorkProjectionMutation(db),
    }),
    threadWorks: createDrizzleThreadWorksRepository(db),
  });
  const core = mode === "direct" ? f.runtime.liveUtilityCore : f.collab.agentEdit();
  const context = { threadId: THREAD_ID, sessionId: THREAD_ID, turnId: TURN_ID };
  const read = (responseId?: string) =>
    core.write(
      { command: "read", file: "alpha.md", documentId: ALPHA_ID },
      { ...context, responseId },
    );
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
    expect(outcome.isError, outcome.text).toBe(false);
    return outcome;
  }
  return { ...f, core, read, current, stage, writerDelete, revisions, effective };
}

describe("document revisions (postgres and collab)", () => {
  for (const mode of ["direct", "draft"] as const) {
    it(`read then current are equal in ${mode} execution`, async () => {
      const f = await fixture(mode);
      const read = await f.read();
      expect(read.revision).toMatch(/^y1:/);
      expect(await f.current()).toBe(read.revision);
    });

    it(`response-end write and staged read equal current in ${mode}; the earlier read does not`, async () => {
      const f = await fixture(mode);
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
    const f = await fixture("direct");
    const before = await f.read();
    await f.writerDelete();
    expect(await f.current()).not.toBe(before.revision);
  });

  it("delivers direct-write settlement receipts to the result-rewrite callback", async () => {
    const f = await fixture("direct");
    await f.read();
    const responseId = "00000000-0000-4000-8000-000000000893";
    await f.stage(responseId);
    const receipts: Array<string | null> = [];
    await f.collab.finalizeResponseCommit(
      responseId,
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        execution: threadExecutionContext({ id: WORK_ID, slug: null, aiWriteMode: "direct" }),
      },
      async (result) => {
        if (result.status === "committed")
          receipts.push(
            ...result.documents.flatMap((doc) => doc.receipts.map((receipt) => receipt.revision)),
          );
      },
    );
    expect(receipts).toEqual([await f.current()]);
  });

  it("captures the apply token before a writer edit and receipt rewrite", async () => {
    const f = await fixture("direct");
    await f.read();
    await f.stage("00000000-0000-4000-8000-000000000893");
    const original = f.liveCoordinator.withDocument.bind(f.liveCoordinator);
    let injected = false;
    f.liveCoordinator.withDocument = (id, callback, options) =>
      original(
        id,
        async (doc) => {
          const result = await callback(doc);
          if (!injected && result && typeof result === "object" && "revision" in result) {
            injected = true;
            await f.writerDelete();
          }
          return result;
        },
        options,
      );
    const committed = await f.core.commitResponse("00000000-0000-4000-8000-000000000893");
    expect(injected).toBe(true);
    const receipt = committed.documents[0]?.receipts[0];
    expect(receipt?.revision).toMatch(/^y1:/);
    expect(receipt?.revision).not.toBe(await f.current());
  });

  it("pulls a live writer edit synchronously before the Work pull debounce fires", async () => {
    const f = await fixture("draft");
    const before = await f.read();
    await f.writerDelete();
    f.branchPulls.scheduleLivePull(ALPHA_ID);
    expect(await f.current()).not.toBe(before.revision);
    expect((await f.read()).revision).toBe(await f.current());
  });

  it("resolves a new Work source after rebind when its text differs", async () => {
    const f = await fixture("draft");
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
    const f = await fixture("direct");
    expect((await f.read()).revision).toMatch(/^y1:/);
    await db
      .update(schema.documents)
      .set({ deletedAt: new Date() })
      .where(eq(schema.documents.id, ALPHA_ID));
    expect(f.hocuspocus.documents.has(ALPHA_ID)).toBe(true);
    expect(await f.current()).toBeNull();
  });

  it("returns null for a source with no Y.Doc", async () => {
    const f = await fixture("direct");
    const binary = "00000000-0000-4000-8000-000000000891";
    const [source] = await db
      .select({ contextSourceId: schema.documents.contextSourceId })
      .from(schema.documents)
      .where(eq(schema.documents.id, ALPHA_ID));
    if (!source) throw new Error("Fixture source missing");
    await db.insert(schema.documents).values({
      id: binary as never,
      contextSourceId: source.contextSourceId,
      name: "unversioned",
      extension: "png",
      fileType: "image",
      mimeType: "image/png",
    });
    const missing = await f.revisions.current({ threadId: THREAD_ID, documentIds: [binary] });
    expect(missing.get(binary)).toBeNull();
  });

  for (const source of ["search-only", "other-thread", "rebind"] as const) {
    it(`PROBE1: refreshes a ${source} Work draft without a current thread peer`, async () => {
      const f = await fixture("draft");
      let workId = WORK_ID;
      if (source === "rebind") {
        await f.read();
        workId = "00000000-0000-4000-8000-000000000890" as WorkId;
        await db.insert(schema.works).values({
          id: workId,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Other draft",
          slug: "other-draft",
          aiWriteMode: "draft",
        });
      }
      await f.liveCoordinator.withDocument(ALPHA_ID, async (liveDoc) => {
        if (source === "other-thread") {
          const other = "00000000-0000-4000-8000-000000000889" as ThreadId;
          await db.insert(schema.threads).values({
            id: other,
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
          });
          await db
            .insert(schema.threadWorks)
            .values({ threadId: other, workId, projectId: PROJECT_ID, isPrimary: true });
          await f.branchStore.ensureThreadPeerBranch({
            documentId: ALPHA_ID,
            threadId: other,
            liveDoc,
          });
        } else {
          await f.branchStore.ensureWorkDraftBranch({ documentId: ALPHA_ID, workId, liveDoc });
        }
      });
      if (source === "rebind")
        await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, workId);
      const hit = await f.effective.readEffectiveHashlines({
        documentId: ALPHA_ID,
        threadId: THREAD_ID,
      });
      if (!hit.ok) throw new Error("Search failed");
      await f.writerDelete();
      f.branchPulls.scheduleLivePull(ALPHA_ID);
      const current = await f.current();
      // Drain before asserting so a failing test cannot leak its timer to another fixture.
      await f.branchPulls.flushLivePull(ALPHA_ID);
      expect(current).not.toBe(hit.value.revision);
      expect(current).toBe((await f.read()).revision);
    });
  }

  it("PROBE2: a joined pull is committed even when its initiating transaction rolls back", async () => {
    const f = await fixture("draft");
    await f.read();
    await f.writerDelete();
    f.branchPulls.scheduleLivePull(ALPHA_ID);
    const entered = deferred();
    const release = deferred();
    const original = f.branchCoordinator.pullFromDoc.bind(f.branchCoordinator);
    let pause = true;
    f.branchCoordinator.pullFromDoc = async (...args) => {
      const result = await original(...args);
      if (pause) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const rollback = deferred();
    const caller = createDrizzleThreadLock(db).withThreadLock(THREAD_ID, async () => {
      await f.branchPulls.flushLivePull(ALPHA_ID);
      await rollback.promise;
      throw new Error("caller rollback");
    });
    const rolledBack = expect(caller).rejects.toThrow("caller rollback");
    await entered.promise;
    const join = f.branchPulls.flushLivePull(ALPHA_ID);
    release.resolve();
    await join;
    const draft = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    const observed = f.model.getBlocks(toDocHandle(draft.doc)).length;
    draft.doc.destroy();
    rollback.resolve();
    await rolledBack;
    await f.branchPulls.flushLivePull(ALPHA_ID);
    expect(observed).toBe(1);
    expect((await f.read()).text).not.toContain("Opening paragraph");
  });

  it("PROBE3: current under the thread lock completes with a contending debounced pull", async () => {
    const f = await fixture("draft");
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
        expect(revision).toMatch(/^y1:/);
      } finally {
        clearTimeout(timer);
      }
    });
    await f.branchPulls.flushLivePull(ALPHA_ID);
  }, 10000);

  for (const existing of [false, true]) {
    it(`pulls under a Work lifecycle lock with ${existing ? "existing" : "new"} peers`, async () => {
      const f = await fixture("draft");
      if (existing) {
        await f.read();
        await f.writerDelete();
      }
      await runInDrizzleTransaction(db, async () => {
        await requireLockedActiveWork(db, WORK_ID);
        await bounded(async () => {
          await f.effective.resolveManifestMembership({
            projectId: PROJECT_ID,
            threadId: THREAD_ID,
          });
          await f.branchPulls.pullThreadPeer({ documentId: ALPHA_ID, threadId: THREAD_ID });
        });
      });
      const peer = await f.branchStore.resolveThreadBranch(ALPHA_ID, THREAD_ID);
      expect(f.model.getBlocks(toDocHandle(peer.doc))).toHaveLength(existing ? 1 : 2);
      peer.doc.destroy();
    });
  }

  it("current under the thread lock handles a cold manifest", async () => {
    const f = await fixture("draft");
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
    const f = await fixture("draft");
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
    await captured.promise;
    await f.writerDelete();
    f.branchPulls.scheduleLivePull(ALPHA_ID);
    const joined = f.branchPulls.flushLivePull(ALPHA_ID);
    release.resolve();
    await Promise.all([older, joined]);
    const draft = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    const blocks = f.model.getBlocks(toDocHandle(draft.doc)).length;
    draft.doc.destroy();
    await f.branchPulls.flushLivePull(ALPHA_ID);
    expect(blocks).toBe(1);
    expect(await f.current()).not.toBe(before);
  });

  it("publishes a root-committed pull even when its caller response aborts", async () => {
    const f = await fixture("draft");
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
    const f = await fixture("draft");
    await runInDrizzleTransaction(db, async () => {
      await f.branchStore.recordManifestDocumentDeleted(ALPHA_ID);
      const membership = await bounded(() =>
        f.effective.resolveManifestMembership({ projectId: PROJECT_ID }),
      );
      expect(membership.members).not.toContain(ALPHA_ID);
    });
  });

  it("returns null when a document is removed from the Work manifest", async () => {
    const f = await fixture("draft");
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
    expect(before.revision).toMatch(/^y1:/);
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
