// Whole Discard revokes Alpha helpers while Beta keeps the response open.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  THREAD_ID,
  USER_ID,
  WORK_ID,
} from "../test-support/change-trail-postgres-harness.js";

import {
  createResponse,
  responseContext,
  stageDraft,
} from "../test-support/document-edit-receipt-fixture.js";

describe("response helper revocation (Postgres)", () => {
  const db = createTestDatabase();
  let harness: ReturnType<typeof createHarness>;

  afterEach(() => {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  });
  afterAll(() => closeDatabase(db));
  let fixture: ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
  let branchId: string;
  let responseId: string;
  let context: ReturnType<typeof responseContext>;
  let core: ReturnType<typeof fixture.collab.agentEdit>;
  beforeEach(async () => {
    await resetDatabase(db);
    harness = createHarness(db);
    ({ fixture, branchId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
      ["blue", "azure"],
    ]));
    responseId = await createResponse(db, 2);
    context = responseContext(responseId);
    core = fixture.collab.agentEdit();
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "green",
          content: "lime",
          tool_use_id: "independent-alpha",
        },
        context,
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
    expect(
      await core.write(
        {
          command: "create",
          file: "beta.md",
          documentId: BETA_ID,
          content: "Beta staged.",
          overwrite: true,
          tool_use_id: "independent-beta",
        },
        { ...context, createdDocument: false },
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
  });
  const discard = () =>
    fixture.collab.draftReview.discardWorkDraft({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branchId,
      userId: USER_ID as never,
    });
  const write = (find: string, content: string, tool_use_id: string) =>
    core.write(
      { command: "replace", file: "alpha.md", documentId: ALPHA_ID, find, content, tool_use_id },
      context,
    );
  async function expectBeta() {
    const beta = await fixture.branchStore.resolveWorkDraftBranchForThread(BETA_ID, THREAD_ID);
    try {
      expect(await fixture.draftMarkdown(beta.branchId)).toBe("Beta staged.\n");
    } finally {
      beta.doc.destroy();
    }
  }
  async function expectFreshWrite(content: string) {
    expect(await write("green", content, "fresh-alpha")).toMatchObject({
      status: "success",
      phase: "staged",
    });
    expect(await harness.commit(responseId)).toMatchObject({
      status: "committed",
      documents: expect.arrayContaining([
        expect.objectContaining({ documentId: ALPHA_ID, updateCount: 1 }),
        expect.objectContaining({ documentId: BETA_ID, updateCount: 1 }),
      ]),
    });
    expect(await fixture.draftMarkdown(branchId)).toBe(`red\n\nblue\n\n${content}\n`);
    await expectBeta();
  }
  it.each([
    { name: "before replay", afterRead: false, discardCount: 1, fresh: "olive" },
    { name: "after replay", afterRead: true, discardCount: 1, fresh: "olive" },
    { name: "recreated and discarded again", afterRead: false, discardCount: 2, fresh: "emerald" },
  ])("held write is revoked $name", async ({ afterRead, discardCount, fresh }) => {
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
      const targeted =
        once && branch === branchId && String(fn).includes("listConcurrentJournalRows");
      if (targeted) once = false;
      if (targeted && !afterRead) {
        entered();
        await gate;
      }
      const result = await original(branch, fn);
      if (targeted && afterRead) {
        entered();
        await gate;
      }
      return result;
    };
    try {
      const pending = write("azure", "cobalt", "held-alpha");
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waiting;
      try {
        for (let index = 0; index < discardCount; index++) {
          if (index > 0)
            expect(await write("green", "olive", "recreated-alpha")).toMatchObject({
              status: "success",
              phase: "staged",
            });
          expect(await discard()).toMatchObject({ status: "discarded" });
        }
      } finally {
        release();
      }
      expect(await settled).toMatchObject({
        value: {
          status: "invalid_write",
          result: {
            message:
              "Write did not land: the user discarded the text it edited. Re-read and retry.",
          },
        },
      });
    } finally {
      release();
      fixture.branchCoordinator.readBranch = original;
    }
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
    await expectFreshWrite(fresh);
  });
  it("whole Discard rejects a held prepared read without revoking Beta", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.branchCoordinator.withStagedRows.bind(fixture.branchCoordinator);
    let once = true;
    fixture.branchCoordinator.withStagedRows = async (...args) => {
      if (once) {
        once = false;
        entered();
        await gate;
      }
      return original(...args);
    };
    try {
      const pending = core.prepare(responseId, ALPHA_ID);
      // Observe rejection before releasing the orphaned read.
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waiting;
      try {
        expect(await discard()).toMatchObject({ status: "discarded" });
      } finally {
        release();
      }
      const outcome = await settled;
      if ("value" in outcome) outcome.value?.dispose();
      expect(outcome).toHaveProperty("error");
    } finally {
      release();
      fixture.branchCoordinator.withStagedRows = original;
    }
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
    await expectFreshWrite("olive");
  });
  it("repeated whole Discard revokes a recreated Alpha while Beta alone commits", async () => {
    expect(await discard()).toMatchObject({ status: "discarded" });
    expect(await write("green", "olive", "recreated-alpha")).toMatchObject({
      status: "success",
      phase: "staged",
    });
    expect(await discard()).toMatchObject({ status: "discarded" });
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
    const read = await core.read({ file: "alpha.md", documentId: ALPHA_ID }, context);
    expect(read.status).toBe("success");
    expect(read.result.blocks?.flatMap((group) => group.items.map((item) => item.body))).toEqual([
      "red",
      "blue",
      "green",
    ]);
    const saved = await harness.commit(responseId);
    expect(saved).toMatchObject({ status: "committed" });
    expect(saved.documents.filter((doc) => doc.updateCount > 0)).toEqual([
      expect.objectContaining({ documentId: BETA_ID, updateCount: 1 }),
    ]);
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
  });
});
