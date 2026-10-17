// Revocable response helpers and accepted replay across draft generation changes.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { setCollabHook } from "../domain/collab-test-hooks.js";
import { readBranchContent } from "../test-support/branch-store-seam.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  runInDrizzleTransaction,
  schema,
  THREAD_ID,
  USER_ID,
  WORK_ID,
} from "../test-support/change-trail-postgres-harness.js";
import {
  createResponse,
  responseContext,
  setupResponseDraft,
} from "../test-support/document-edit-receipt-fixture.js";
import { reviewDriver } from "../test-support/draft-review-requests.js";

async function expectScopedReplay(
  fixture: ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>,
  responseId: string,
) {
  const { createEffectiveDocumentReader } = await import("../domain/effective-document-reader.js");
  const reader = createEffectiveDocumentReader({
    branches: fixture.branchStore,
    branchCoordinator: fixture.branchCoordinator,
    branchPulls: fixture.branchPulls,
    liveCoordinator: fixture.liveCoordinator,
    agentEdit: fixture.collab.agentEdit(),
    documents: fixture.runtime.markdownDocuments,
    model: fixture.runtime.model,
    codec: fixture.runtime.codec,
    links: fixture.links,
    drafts: {
      viewForWork: async (workId) => {
        const { draftId } = await fixture.collab.draftReview.items({ workId: workId as never });
        return draftId ? { kind: "draft", draftId } : { kind: "live" };
      },
    },
    retirePeers: async () => {},
    deferUntilCommit: () => false,
  });
  const args = {
    documentId: ALPHA_ID,
    threadId: THREAD_ID,
    responseId,
    destination: "draft" as const,
    workId: WORK_ID,
  };
  const markdown = await reader.readEffectiveMarkdown(args);
  expect(markdown).toMatchObject({ ok: true });
  if (markdown.ok) expect(markdown.value.content).toBe("red\n\nazure\n\nlime\n");
  const hashlines = await reader.readEffectiveHashlines(args);
  expect(hashlines).toMatchObject({ ok: true });
  if (hashlines.ok)
    expect(hashlines.value.content.map((block) => block.slice(block.indexOf("|") + 1))).toEqual([
      "red",
      "azure",
      "lime",
    ]);
}

describe("response helper replay (Postgres)", () => {
  const db = createTestDatabase();
  let harness: ReturnType<typeof createHarness>;
  beforeEach(async () => {
    await resetDatabase(db);
    harness = createHarness(db);
  });
  afterEach(() => {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  });
  afterAll(() => closeDatabase(db));
  it.each([
    false,
    true,
  ])("first write paused during Discard rebases on the current generation (empty: %s)", async (empty) => {
    const { fixture, branchId, responseId, write, review } = await setupResponseDraft(
      db,
      harness,
      empty,
    );
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Pause the write before it reads its branches, so Discard commits ahead of it.
    let paused = false;
    const unhook = setCollabHook("branch.beforeAccess", async () => {
      if (!paused) {
        paused = true;
        entered();
        await gate;
      }
    });
    const writing = write("green", "lime");
    await waiting;
    try {
      await review("gold");
    } finally {
      release();
      unhook();
    }
    expect(await writing).toMatchObject({ status: "success", phase: "staged" });
    expect(await harness.commit(responseId)).toMatchObject({
      status: "committed",
      documents: [{ updateCount: 1 }],
    });
    expect(await fixture.draftMarkdown(branchId)).toBe(
      empty ? "red\n\nblue\n\nlime\n" : "red\n\nazure\n\nlime\n",
    );
  });
  async function expectDroppedCommit(
    draft: Awaited<ReturnType<typeof setupResponseDraft>>,
    dropped: Awaited<ReturnType<typeof draft.write>>[],
    updateCount: number,
    markdown: string,
    generation = 2,
  ) {
    const saved = await harness.commit(draft.responseId);
    expect(saved).toMatchObject({ status: "committed", documents: [{ updateCount }] });
    const receipts = saved.documents.flatMap((doc) => doc.receipts);
    expect(
      receipts
        .filter((receipt) => receipt.result.status !== "success")
        .map((receipt) => ({ id: receipt.settlementId, message: receipt.result.message })),
    ).toEqual(
      dropped.map((entry) => ({
        id: entry.settlementId,
        message: "Write did not land: the user discarded the text it edited. Re-read and retry.",
      })),
    );
    expect(await draft.fixture.draftMarkdown(draft.branchId)).toBe(markdown);
    expect(await harness.branchGeneration(draft.branchId)).toBe(generation);
  }
  it("held read replays after Discard empties the persisted draft", async () => {
    const { fixture, branchId, responseId, read, write, review } = await setupResponseDraft(
      db,
      harness,
      true,
    );
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Pause the read before it reads any branch, so Discard commits ahead of it.
    let once = true;
    const unhook = setCollabHook("branch.beforeAccess", async () => {
      if (once) {
        once = false;
        entered();
        await gate;
      }
    });
    const reading = read();
    await waiting;
    try {
      await review("gold");
    } finally {
      release();
    }
    try {
      const result = await reading;
      expect(result.status).toBe("success");
      expect(
        result.result.blocks?.flatMap((group) => group.items.map((item) => item.body)),
      ).toEqual(["red", "blue", "lime"]);
    } finally {
      unhook();
    }
    expect(await read()).toMatchObject({ status: "success" });
    expect(
      await fixture.collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
      }),
    ).toEqual([]);
    const { createDrizzleWorkDraftPendingStore } = await import("./drizzle-branch-push.js");
    expect(await createDrizzleWorkDraftPendingStore(db).countPendingByWorkIds([WORK_ID])).toEqual(
      new Map(),
    );
    expect(await harness.commit(responseId)).toMatchObject({
      status: "committed",
      documents: [{ updateCount: 1 }],
    });
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\nlime\n");
    expect(await harness.branchGeneration(branchId)).toBe(2);
  });
  it("reply replays after Apply empties the persisted draft", async () => {
    const { fixture, branchId, responseId, write, review } = await setupResponseDraft(
      db,
      harness,
      true,
    );
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    await review("gold", true);
    expect(await harness.commit(responseId)).toMatchObject({
      status: "committed",
      documents: [{ updateCount: 1 }],
    });
    expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nblue\n\nlime\n");
    expect(await harness.branchGeneration(branchId)).toBe(2);
  });
  it("whole Discard rolls back the only staged document in a reply", async () => {
    const { fixture, branchId, responseId, write } = await setupResponseDraft(db, harness, true);
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    const open = await fixture.branchStore.getBranch(branchId);
    expect(await reviewDriver(fixture.collab.draftReview).discardAll()).toMatchObject({
      status: "discarded",
    });
    // Closing the draft's branches is a review-membership input: it moves their revision (§2.5).
    expect((await fixture.branchStore.getBranch(branchId))?.revision).toBeGreaterThan(
      open?.revision ?? Number.POSITIVE_INFINITY,
    );
    // Discard all closes the draft: the save refuses the write with its receipt (contract §2.2).
    const saved = await harness.commit(responseId);
    expect(saved).toMatchObject({ status: "committed", documents: [{ updateCount: 0 }] });
    expect(saved.documents[0]?.receipts).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          status: "invalid_write",
          message: "Write did not land: the user discarded this draft. Re-read and retry.",
        }),
      }),
    ]);
    expect(await fixture.branchStore.getBranch(branchId)).toMatchObject({ status: "closed" });
  });
  it("save reports dropped dependent writes once while a held write replays", async () => {
    const draft = await setupResponseDraft(db, harness);
    const { fixture, responseId, read, write, review } = draft;
    const dropped = [await write("gold", "gild"), await write("gild", "bronze")];
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let once = true;
    const unhook = setCollabHook("branch.beforeAccess", async () => {
      if (once) {
        once = false;
        entered();
        await gate;
      }
    });
    const writing = write("lime", "olive");
    await waiting;
    try {
      await review("gold");
      await expectScopedReplay(fixture, responseId);
    } finally {
      release();
    }
    try {
      const result = await writing;
      expect(result.status).toBe("success");
      expect(result.result.message?.split("Dropped writes:")).toHaveLength(3);
    } finally {
      unhook();
    }
    expect((await read()).result.message).toBeUndefined();
    await expectDroppedCommit(draft, dropped, 2, "red\n\nazure\n\nolive\n");
  });
  it.each([
    {
      name: "independent survivor",
      initialWrites: [["green", "lime"]],
      laterWrites: [["red", "silver"]],
      discard: ["gold"],
      updateCount: 2,
      markdown: "silver\n\nazure\n\nlime\n",
      generation: 2,
    },
    {
      name: "all staged writes dropped",
      initialWrites: [],
      laterWrites: [],
      discard: ["gold", "azure"],
      updateCount: 0,
      markdown: "red\n\nblue\n\ngreen\n",
      generation: 3,
    },
  ])("next tool reports both dropped writes and resolves the re-fork ($name)", async ({
    initialWrites,
    laterWrites,
    discard,
    updateCount,
    markdown,
    generation,
  }) => {
    const draft = await setupResponseDraft(db, harness);
    const { write, read, review } = draft;
    const dropped = [await write("gold", "gild"), await write("gild", "bronze")];
    for (const [find, content] of initialWrites)
      expect(await write(find, content)).toMatchObject({ status: "success", phase: "staged" });
    await review(discard[0]);
    const missing = await write("gold", "missing");
    expect(missing.status).toBe("not_found");
    expect(new Set(dropped.map((entry) => entry.writeId)).size).toBe(2);
    for (const [index, entry] of dropped.entries()) {
      const description = index === 0 ? '"gold" → "gild"' : '"gild" → "bronze"';
      expect(missing.result.message).toContain(
        `alpha.md ${entry.writeId}: all staged writes for this handle was discarded with the text it edited. Dropped writes: ${description}. Re-read and retry.`,
      );
    }
    expect(missing.result.message?.split("Dropped writes:")).toHaveLength(3);
    for (const [find, content] of laterWrites)
      expect(await write(find, content)).toMatchObject({ status: "success", phase: "staged" });
    for (const after of discard.slice(1)) await review(after);
    expect(await read()).toMatchObject({ status: "success" });
    await expectDroppedCommit(draft, dropped, updateCount, markdown, generation);
  });
  it("a save that misses all four attempts leaves an accepted fresh replay for retry", async () => {
    const draft = await setupResponseDraft(db, harness);
    const { fixture, branchId, responseId, write, review } = draft;
    const dropped = [await write("gold", "gild"), await write("gild", "bronze")];
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    await review("gold");
    const original = fixture.branchStore.appendRows.bind(fixture.branchStore);
    let misses = 0;
    fixture.branchStore.appendRows = async (request) => {
      if (request.branchId === branchId) {
        misses += 1;
        return { status: "moved" };
      }
      return original(request);
    };
    try {
      await expect(harness.commit(responseId)).rejects.toThrow();
    } finally {
      fixture.branchStore.appendRows = original;
    }
    // Four commit attempts, each recaptured; the fifth never runs.
    expect(misses).toBe(4);
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n\ngreen\n");
    const lease = await fixture.collab.agentEdit().prepare(responseId, ALPHA_ID);
    if (!lease) throw new Error("Missing prepared lease");
    try {
      // A post-failure exposure is itself an accepted fresh replay, not a raw buffer peek.
      expect(
        fixture.model.getBlocks(lease.doc).map((block) => fixture.model.getText(block)),
      ).toEqual(["red", "azure", "lime"]);
    } finally {
      lease.dispose();
    }
    await expectDroppedCommit(draft, dropped, 1, "red\n\nazure\n\nlime\n");
  });
  it("a save whose second document moves between capture and commit unwinds whole and commits both next", async () => {
    const { fixture, branchId, responseId, context, write } = await setupResponseDraft(db, harness);
    const core = fixture.collab.agentEdit();
    const writeBeta = (
      command: "create" | "replace",
      content: string,
      ctx: ReturnType<typeof responseContext>,
    ) =>
      core.write(
        {
          command,
          file: "beta.md",
          documentId: BETA_ID,
          ...(command === "create"
            ? { content, overwrite: true }
            : { find: "Beta seeded.", content }),
          tool_use_id: `beta-${command}`,
        },
        { ...ctx, createdDocument: false },
      );
    // Beta's draft branch is durable before this reply saves: an earlier reply made it.
    const earlier = await createResponse(db, 3);
    expect(await writeBeta("create", "Beta seeded.", responseContext(earlier))).toMatchObject({
      phase: "staged",
    });
    expect(await harness.commit(earlier)).toMatchObject({ status: "committed" });
    const beta = await fixture.branchStore.resolveWorkDraftBranchForThread(BETA_ID, THREAD_ID);
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    expect(await writeBeta("replace", "Beta staged.", context)).toMatchObject({ phase: "staged" });
    const rowsOf = async (id: string) =>
      (
        await db
          .select({ id: schema.branchWriteJournal.id })
          .from(schema.branchWriteJournal)
          .where(
            and(
              eq(schema.branchWriteJournal.branchId, id),
              eq(schema.branchWriteJournal.source, "agent"),
            ),
          )
      ).length;
    const before = { alpha: await rowsOf(branchId), beta: await rowsOf(beta.branchId) };

    const original = fixture.branchStore.appendRows.bind(fixture.branchStore);
    const appends: string[] = [];
    fixture.branchStore.appendRows = async (request) => {
      appends.push(request.branchId === branchId ? "alpha" : "beta");
      if (appends.length === 2 && request.branchId === beta.branchId) {
        // A frame on another connection moves Beta after the attempt judged it.
        await db
          .update(schema.documentBranches)
          .set({ revision: sql`${schema.documentBranches.revision} + 1` })
          .where(eq(schema.documentBranches.id, beta.branchId));
      }
      return original(request);
    };
    let saved: Awaited<ReturnType<typeof harness.commit>>;
    try {
      saved = await harness.commit(responseId);
    } finally {
      fixture.branchStore.appendRows = original;
    }
    // Alpha appended in the first attempt; Beta's miss unwound it, and the second attempt
    // judged both again from the reply's original staged entries.
    expect(appends).toEqual(["alpha", "beta", "alpha", "beta"]);
    expect(saved).toMatchObject({ status: "committed" });
    expect(await rowsOf(branchId)).toBe(before.alpha + 1);
    expect(await rowsOf(beta.branchId)).toBe(before.beta + 1);
    expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\nlime\n");
    expect(await fixture.draftMarkdown(beta.branchId)).toBe("Beta staged.\n");
  });
  it("retired ambient peer and aborted rollback cannot replace a replayed helper", async () => {
    const { fixture, branchId, responseId, read, write, review } = await setupResponseDraft(
      db,
      harness,
      false,
    );
    const writer = async () => {
      const snapshot = await fixture.branchStore.getBranch(branchId);
      if (!snapshot) throw new Error("Missing branch");
      const content = await readBranchContent(fixture.branchStore, branchId);
      const room = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(room, content);
        const updates: Uint8Array[] = [];
        room.on("update", (update) => updates.push(update));
        const text = (room.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(
          0,
        ) as Y.XmlText;
        room.transact(() => {
          text.delete(0, text.length);
          text.insert(0, "pink");
        });
        expect(
          await fixture.branchCoordinator.commitWriterUpdate({
            branchId,
            expectedGeneration: snapshot.generation,
            updateData: Y.mergeUpdates(updates),
            roomDocument: room,
            actorUserId: USER_ID as never,
          }),
        ).toEqual({ admitted: true });
      } finally {
        room.destroy();
      }
    };
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.branchCoordinator.readBranch.bind(fixture.branchCoordinator);
    let once = true;
    fixture.branchCoordinator.readBranch = async (branch, fn) => {
      if (once && branch === branchId && String(fn).includes("listConcurrentJournalRows")) {
        once = false;
        entered();
        await gate;
      }
      return original(branch, fn);
    };
    const writing = write("green", "lime");
    await waiting;
    try {
      await writer();
    } finally {
      release();
    }
    try {
      expect(await writing).toMatchObject({ status: "success" });
    } finally {
      fixture.branchCoordinator.readBranch = original;
    }
    await review("pink");
    expect(await read()).toMatchObject({ status: "success" });
    // An aborted rollback must not replace the helper with this ambient peer.
    await writer();
    const { draftId } = await fixture.collab.draftReview.items({ workId: WORK_ID });
    await fixture.branchPulls.pullThreadPeer({
      documentId: ALPHA_ID,
      threadId: THREAD_ID,
      draftId: draftId ?? undefined,
    });
    await expect(
      runInDrizzleTransaction(db, async () => {
        await fixture.collab.agentEdit().rollbackResponse(responseId);
        throw new Error("rollback abort probe");
      }),
    ).rejects.toThrow("rollback abort probe");
    await review("pink");
    await expectScopedReplay(fixture, responseId);
    expect(await read()).toMatchObject({ status: "success" });
    expect(await harness.commit(responseId)).toMatchObject({
      status: "committed",
      documents: [{ updateCount: 1 }],
    });
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n\nlime\n");
  });
});
