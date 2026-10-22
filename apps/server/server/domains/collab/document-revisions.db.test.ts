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
  runOutsideDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { createTestDocumentRemoval } from "../../test-support/document-removal.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDrizzleLineageScratchLifecycle } from "../context/adapters/lineage-scratch-lifecycle.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createDocumentRevisions } from "../context/index.js";
import { createLocalFileAccessChanges, type FileDestination } from "../file-policy/index.js";
import { createDrizzleProjectWorkRepository } from "../projects/index.js";
import { createDrizzleThreadLock } from "../runtime/adapters/drizzle-thread-lock.js";
import { createDrizzleThreadRepository } from "../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createBranches } from "./domain/branches.js";
import { scopeDraftPeer } from "./domain/document-link-scope-doors.js";
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
import { readResolvedDraft } from "./test-support/draft-store-seam.js";

/** The grant names this project and its owner, as the file policy would: the read's scope key. */
function inProject<T extends ReturnType<typeof testFileGrant>>(grant: T): T {
  return {
    ...grant,
    principal: { ...grant.principal, accountId: USER_ID },
    facts: { ...grant.facts, projectId: PROJECT_ID },
  };
}

const identity = (responseId: string) => ({
  providerResponseId: responseId,
  editScopeId: responseId,
});

async function fixture(
  db: Database,
  harnesses: Array<ReturnType<typeof createHarness>>,
  mode: "direct" | "draft",
  options: { links?: DocumentLinkScopes } = {},
) {
  const harness = createHarness(db, options.links ? { links: options.links } : {});
  harnesses.push(harness);
  const f = harness.crossWorkProbeFixture();
  await db
    .update(schema.threads)
    .set({ aiWriteMode: mode })
    .where(eq(schema.threads.id, THREAD_ID));
  await f.persistence.seeds.seedInitialDocument(ALPHA_ID, Y.encodeStateAsUpdate(new Y.Doc()));
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
  // The reads spell from the harness's scope, so their revisions compare with these.
  const links = f.links;
  const branches = createBranches({
    store: createDrizzleBranchStore(db),
    boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
  });
  const effective = scopeDraftPeer(
    createEffectiveDocumentReader({
      drafts: f.draftStore,
      draftPulls: f.draftPulls,
      agentEdit: f.collab.agentEdit(),
      documents: f.runtime.markdownDocuments,
      model: f.runtime.model,
      codec: f.runtime.codec,
      links,
      branches,
    }),
    links,
  );
  const revisions = createDocumentRevisions({
    links,
    threads: createDrizzleThreadRepository(db, {
      lineageScratch: createDrizzleLineageScratchLifecycle(db),
    }),
    availability: createDrizzleProjectContextAvailability(db),
    documents: effective,
    branches,
    works: createDrizzleProjectWorkRepository({
      removal: createTestDocumentRemoval(db),
      lineageScratch: createDrizzleLineageScratchLifecycle(db),
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
    grant: inProject(
      testFileGrant(
        mode === "direct"
          ? { kind: "live" }
          : { kind: "draft", workId: WORK_ID, workHandle: "atomicity-work" },
      ),
    ),
  };
  const read = (responseId?: string, destination?: FileDestination) =>
    core.read(
      { file: "alpha.md", documentId: ALPHA_ID },
      {
        ...context,
        ...(responseId ? { responseIdentity: identity(responseId) } : {}),
        ...(destination ? { grant: inProject(testFileGrant(destination)) } : {}),
      },
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
      { ...context, responseIdentity: identity(responseId), createdDocument: false },
    );
    expect(outcome.isError, renderAgentEditResult(outcome.result)).toBe(false);
    return outcome;
  }
  return { ...f, branches, core, read, current, stage, writerDelete, revisions, effective };
}

describe("document revisions (postgres and collab)", () => {
  const db = createTestDatabase();
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  beforeEach(() => resetDatabase(db));
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      harness.cancelScheduledPulls();
      await harness.settleDraftEffects();
    }
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
    const f = await fixture(db, harnesses, "direct", {
      links: createTestDocumentLinkScopes(db, {}),
    });
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
    // The model's read and the revision-only path agree under real scopes, or
    // compaction would never elide a copy.
    expect((await f.read()).revision).toBe(shown);

    // Nothing in alpha changes; only where its link's target sits.
    await db
      .update(schema.documents)
      .set({ name: "gamma" })
      .where(eq(schema.documents.id, BETA_ID));
    const moved = await f.current();
    expect(moved).not.toBe(shown);
    expect((await f.read()).revision).toBe(moved);

    // A drafted view follows live locations for documents it did not create.
    const view = {
      documentId: ALPHA_ID,
      threadId: THREAD_ID,
      destination: "draft" as const,
      workId: WORK_ID,
    };
    const markdown = await f.effective.readEffectiveMarkdown(view);
    const hashlines = await f.effective.readEffectiveHashlines(view);
    const revision = await f.effective.readEffectiveRevision(view);
    if (!markdown.ok || !hashlines.ok) throw new Error(JSON.stringify({ markdown, hashlines }));
    expect.soft(hashlines.value.content.join("\n"), "hashlines").toContain("[Beta](gamma)");
    expect.soft(markdown.value.content, "Markdown").toContain("[Beta](gamma)");
    expect
      .soft([markdown.value.revision, revision], "one view")
      .toEqual([hashlines.value.revision, hashlines.value.revision]);
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
      handle: "w2",
    });
    await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, workB);
    expect(await f.current()).not.toBe(before.revision);
    // The thread's grants now name Work B, which has no branch yet: the read is live (S1).
    const rebound = { kind: "draft", workId: workB, workHandle: "other-draft" } as const;
    expect((await f.read(undefined, rebound)).revision).toBe(await f.current());
  });

  it("does not treat a deleted document's still-loaded room as a readable source", async () => {
    const f = await fixture(db, harnesses, "direct");
    expect((await f.read()).revision).toMatch(/^y2:/);
    await db
      .update(schema.documents)
      .set({ deletionReason: "deleted", deletedAt: new Date() })
      .where(eq(schema.documents.id, ALPHA_ID));
    expect(f.hocuspocus.documents.has(ALPHA_ID)).toBe(true);
    expect(await f.current()).toBeNull();
  });

  it("current under the thread lock completes with a contending live pull", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.provisionDraft();
    await f.read();
    await f.writerDelete();
    const originalPull = f.draftCoordinator.loadBase;
    const originalCopy = f.draftCoordinator.copyDraft;
    const draft = await f.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID);
    const workDraftId = draft.draftId;
    const contending = deferred();
    let pulling: Promise<void> | undefined;
    let reading: ReturnType<typeof f.current> | undefined;
    let reached = false;
    f.draftCoordinator.loadBase = async (...args) => {
      if (pulling && args[0] === workDraftId) {
        reached = true;
        contending.resolve();
      }
      return originalPull(...args);
    };
    // Foreground reads copy the draft; readDraft belongs to background projection.
    f.draftCoordinator.copyDraft = async (id) => {
      if (!pulling && id === workDraftId) {
        await f.writerDelete();
        pulling = runOutsideDrizzleTransaction(() => f.draftPulls.flushLivePull(ALPHA_ID));
        await Promise.race([contending.promise, pulling]);
      }
      return originalCopy(id);
    };
    try {
      await createDrizzleThreadLock(db).withThreadLock(THREAD_ID, async () => {
        const current = f.current();
        reading = current;
        expect(await bounded(() => current)).toMatch(/^y2:/);
        expect(reached).toBe(true);
      });
    } finally {
      f.draftCoordinator.copyDraft = originalCopy;
      f.draftCoordinator.loadBase = originalPull;
      // A deadline releases the thread lock before joining its unfinished reads and pulls.
      await Promise.allSettled([reading]);
      await Promise.allSettled([pulling]);
    }
    await pulling;
  }, 10000);

  it("a flush joining an older snapshot waits for a fresh committed pull", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.liveCoordinator.withDocument(ALPHA_ID, async (liveDoc) => {
      const branch = await f.branches.activeForWork(WORK_ID);
      if (!branch) throw new Error("the harness seeds the Work's branch");
      await f.draftStore.ensureDocumentDraft({
        documentId: ALPHA_ID,
        branchId: branch.id,
        liveDoc,
      });
    });
    const before = await f.current();
    const captured = deferred();
    const release = deferred();
    const original = f.persistence.journal.read.bind(f.persistence.journal);
    let pause = true;
    f.persistence.journal.read = async (...args) => {
      const snapshot = await original(...args);
      if (pause) {
        pause = false;
        captured.resolve();
        await release.promise;
      }
      return snapshot;
    };
    const older = f.draftPulls.flushLivePull(ALPHA_ID);
    const started = [older];
    try {
      await Promise.race([
        captured.promise,
        older.then(() => {
          throw new Error("Older pull completed without reaching its snapshot latch");
        }),
      ]);
      await f.writerDelete();
      f.draftPulls.scheduleLivePull(ALPHA_ID);
      const joined = f.draftPulls.flushLivePull(ALPHA_ID);
      started.push(joined);
      release.resolve();
      await Promise.all(started);
      const draft = await readResolvedDraft(
        f.draftStore,
        await f.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID),
      );
      const blocks = f.model.getBlocks(toDocHandle(draft.doc)).length;
      draft.doc.destroy();
      await f.draftPulls.flushLivePull(ALPHA_ID);
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
      Promise.all(documentIds.map((documentId) => f.draftPulls.flushLivePull(documentId))),
    );
  });

  it("keeps a root-committed ensure even when its caller response aborts", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.read();
    await f.writerDelete();
    const branch = await f.branches.ensureActiveForWrite({
      workId: WORK_ID,
      projectId: PROJECT_ID as never,
      threadId: THREAD_ID,
      userId: USER_ID as never,
    });
    await expect(
      runResponseTransaction(
        (operation) => runInDrizzleTransaction(db, operation),
        async () => {
          await f.draftPulls.ensureThreadPeer({
            documentId: ALPHA_ID,
            threadId: THREAD_ID,
            branchId: branch.id,
          });
          throw new Error("response aborted");
        },
      ),
    ).rejects.toThrow("response aborted");
    // The ensure commits the peer identity and fresh Work draft under its own root.
    const peer = await readResolvedDraft(
      f.draftStore,
      await f.draftStore.resolveThreadDraft(ALPHA_ID, THREAD_ID),
    );
    expect(f.model.getBlocks(toDocHandle(peer.doc))).toHaveLength(1);
    const workDraft = await readResolvedDraft(
      f.draftStore,
      await f.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID),
    );
    expect(f.model.getBlocks(toDocHandle(workDraft.doc))).toHaveLength(1);
    workDraft.doc.destroy();
    peer.doc.destroy();
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
