/**
 * Contract §2.6 DB cases: what a reply's staged writes become when the writer's Discard, Apply
 * or an archive lands before the save. A refusal is a receipt, never a thrown save.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "./adapters/drizzle-drafts.js";
import { createDrafts } from "./domain/drafts.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  SOURCE_ID,
  schema,
  THREAD_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import {
  seedSecondWork,
  THREAD_B_ID,
  TURN_B_ID,
  WORK_B_ID,
} from "./test-support/cross-work-probe-harness.js";
import {
  createResponse,
  responseContext,
  stageDraft,
} from "./test-support/document-edit-receipt-fixture.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";

const DRAFT = "Write did not land: the user discarded this draft. Re-read and retry.";
const EDIT = "Write did not land: the user discarded the text it edited. Re-read and retry.";
const DOC = "Write did not land: the user discarded this new document. Re-read and retry.";

type Saved = Awaited<ReturnType<ReturnType<typeof createHarness>["commit"]>>;
/** Each refused write's document and the copy its receipt carries, in save order. */
function refused(saved: Saved) {
  return saved.documents.flatMap((doc) =>
    doc.receipts.flatMap((receipt) =>
      receipt.result.status === "invalid_write" ? [[doc.documentId, receipt.result.message]] : [],
    ),
  );
}

describe("reply save refusals (postgres)", () => {
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

  /** Alpha holds two persisted AI changes; a second reply then stages its own writes. */
  async function setup() {
    const staged = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
      ["blue", "azure"],
    ]);
    const { fixture } = staged;
    const responseId = await createResponse(db, 2);
    const context = responseContext(responseId);
    const core = fixture.collab.agentEdit();
    const review = reviewDriver(fixture.collab.draftReview);
    const write = (find: string, content: string, id: string) =>
      core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find,
          content,
          tool_use_id: id,
        },
        context,
      );
    return { ...staged, responseId, context, core, review, write };
  }

  it("1: independent staged writes survive a per-change Discard and land at generation +1", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await write("gold", "silver", "w-gold")).toMatchObject({ phase: "staged" });
    const preview = await review.activePreview(ALPHA_ID);
    const azure = preview.operations.find((op) => op.afterExcerpt === "azure");
    expect(
      await review.discardChanges(ALPHA_ID, preview, [azure?.operationId as string]),
    ).toMatchObject({
      status: "discarded",
    });
    const saved = await harness.commit(responseId);
    expect(saved).toMatchObject({ status: "committed", documents: [{ updateCount: 2 }] });
    expect(await fixture.draftMarkdown(branchId)).toBe("silver\n\nblue\n\nlime\n");
    expect(await harness.branchGeneration(branchId)).toBe(2);
  });

  it("3: Discard all while staged refuses the save with one receipt per write and nothing live", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await write("gold", "silver", "w-gold")).toMatchObject({ phase: "staged" });
    expect(await review.discardAll()).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([
      [ALPHA_ID, DRAFT],
      [ALPHA_ID, DRAFT],
    ]);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n\ngreen\n");
    expect(await review.list()).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toContain("gold");
  });

  it("2: after two reforks and a prepared read, only edits on discarded text fail", async () => {
    const { fixture, branchId, responseId, review, write, core, context } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await write("azure", "cyan", "w-azure")).toMatchObject({ phase: "staged" });
    const first = await review.activePreview(ALPHA_ID);
    const azure = first.operations.find((op) => op.afterExcerpt === "azure");
    await review.discardChanges(ALPHA_ID, first, [azure?.operationId as string]);
    expect(
      await core.read({ file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-2" }, context),
    ).toMatchObject({ status: "success" });
    const second = await review.activePreview(ALPHA_ID);
    await review.discardChanges(ALPHA_ID, second);
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\nlime\n");
  });

  it("4: a mixed reply saves its other document; a fully refused reply still receipts every write", async () => {
    const { fixture, branchId, responseId, review, write, core, context } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(
      await core.write(
        {
          command: "create",
          file: "beta.md",
          documentId: BETA_ID,
          content: "Beta staged.",
          overwrite: true,
          tool_use_id: "w-beta",
        },
        { ...context, createdDocument: false },
      ),
    ).toMatchObject({ phase: "staged" });
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
    expect(saved.documents.map((doc) => doc.documentId).sort()).toEqual([ALPHA_ID, BETA_ID].sort());
    const beta = await fixture.branchStore.resolveWorkDraftBranchForThread(BETA_ID, THREAD_ID);
    beta.doc.destroy();
    expect(await fixture.draftMarkdown(beta.branchId)).toBe("Beta staged.\n");
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
  });

  it("5: a write after Discard all in the same reply lands in a fresh draft beside the first refusal", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.discardAll()).toMatchObject({ status: "discarded" });
    const later = await write("blue", "navy", "w-blue");
    expect(later).toMatchObject({ phase: "staged" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, DRAFT]]);
    expect(saved.documents[0]?.receipts).toHaveLength(2);
    const fresh = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    fresh.doc.destroy();
    expect(fresh.branchId).not.toBe(branchId);
    expect(await fixture.draftMarkdown(fresh.branchId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  /** A document the draft created and has not revealed: hidden, with its tree row. */
  async function hiddenCreate(
    _fixture: ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>,
    documentId: string,
    name: string,
    workId = WORK_ID,
    threadId = THREAD_ID,
  ) {
    const draft = await createDrafts({
      store: createDrizzleDraftStore(db),
      boundary: createDrizzleDraftWriteBoundary(db),
    }).ensureActiveForWrite({
      workId,
      projectId: PROJECT_ID as never,
      threadId,
      userId: USER_ID as never,
    });
    await db.insert(schema.documents).values({
      id: documentId as never,
      contextSourceId: SOURCE_ID,
      name,
      extension: "",
      hidden: true,
    });
    await db.insert(schema.draftTreeChanges).values({
      draftId: draft.id,
      nodeKind: "document",
      nodeId: documentId as never,
      created: true,
      contextSourceId: SOURCE_ID as never,
      parentFolderId: null,
      name,
      extension: "",
    });
    return draft.id;
  }
  const NEW_ID = "00000000-0000-4000-8000-000000000830";
  const grantFor = (documentId: string, workId = WORK_ID, slug = "atomicity-work") => {
    const granted = testFileGrant({ kind: "draft", workId, workSlug: slug }, documentId);
    return {
      ...granted,
      principal: { ...granted.principal, accountId: USER_ID as never },
      facts: { ...granted.facts, projectId: PROJECT_ID as never },
    };
  };

  /** A reply that created `NEW_ID` in the draft and saved, then a second reply staging an edit on it. */
  async function createdThenStaged() {
    const base = await setup();
    const { fixture, core } = base;
    await hiddenCreate(fixture, NEW_ID, "created");
    const first = await createResponse(db, 3);
    expect(
      await core.write(
        { command: "create", file: "created", documentId: NEW_ID as never, content: "New." },
        { ...responseContext(first), grant: grantFor(NEW_ID), createdDocument: true },
      ),
    ).toMatchObject({ phase: "staged" });
    expect(await harness.commit(first)).toMatchObject({ status: "committed" });
    const second = await createResponse(db, 4);
    const context = { ...responseContext(second), grant: grantFor(NEW_ID) };
    expect(
      await core.write(
        {
          command: "replace",
          file: "created",
          documentId: NEW_ID as never,
          find: "New.",
          content: "Newer.",
          tool_use_id: "w-new",
        },
        context,
      ),
    ).toMatchObject({ phase: "staged" });
    return { ...base, second };
  }

  it("13: Discard of a created item while staged refuses discarded_document and leaves its tombstone", async () => {
    const { second, review } = await createdThenStaged();
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(second);
    expect(refused(saved)).toEqual([[NEW_ID, DOC]]);
    const [row] = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, NEW_ID as never));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("15: Discard of a revealed create refuses discarded_edit, not discarded_document", async () => {
    const { second, review, fixture } = await createdThenStaged();
    await db
      .update(schema.documents)
      .set({ hidden: false })
      .where(eq(schema.documents.id, NEW_ID as never));
    await db
      .delete(schema.draftTreeChanges)
      .where(eq(schema.draftTreeChanges.nodeId, NEW_ID as never));
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(second);
    expect(refused(saved)).toEqual([[NEW_ID, EDIT]]);
    void fixture;
  });

  it("10: a pooled peer and a per-change Discard: a fresh read shows none of the discarded text and the write lands", async () => {
    const { fixture, branchId, responseId, context, core, review } = await setup();
    const preview = await review.activePreview(ALPHA_ID);
    const azure = preview.operations.find((op) => op.afterExcerpt === "azure");
    await review.discardChanges(ALPHA_ID, preview, [azure?.operationId as string]);
    const read = await core.read(
      { file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-10" },
      context,
    );
    expect(JSON.stringify(read.result)).not.toContain("azure");
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "gold",
          content: "silver",
          tool_use_id: "w-10",
        },
        context,
      ),
    ).toMatchObject({ phase: "staged" });
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toBe("silver\n\nblue\n\ngreen\n");
    expect(await harness.branchGeneration(branchId)).toBe(2);
  });

  it("11: Apply all while staged drains the draft, which stays active, and the write lands in it", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.applyAll()).toMatchObject({ status: "completed" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nazure\n\ngreen\n");
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\nlime\n");
    expect((await fixture.collab.draftReview.items({ workId: WORK_ID })).draftId).not.toBeNull();
  });

  it("12: switching to direct after Apply all while staged still lands the write in the draft", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.applyAll()).toMatchObject({ status: "completed" });
    await db
      .update(schema.works)
      .set({ aiWriteMode: "direct" })
      .where(eq(schema.works.id, WORK_ID));
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\nlime\n");
  });

  it("9 and 14: an item Discard refuses this Work's staged writes, never another Work's on the same document", async () => {
    const { fixture, responseId, review, write } = await setup();
    await seedSecondWork(fixture);
    const core = fixture.collab.agentEdit();
    const second = await db
      .insert(schema.modelResponses)
      .values({
        id: crypto.randomUUID() as never,
        turnId: TURN_B_ID,
        sequence: 1,
        provider: "mock",
        model: "mock",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      })
      .returning({ id: schema.modelResponses.id });
    const responseB = second[0]?.id as string;
    const contextB = {
      sessionId: THREAD_B_ID,
      threadId: THREAD_B_ID,
      turnId: TURN_B_ID,
      responseIdentity: { providerResponseId: responseB, editScopeId: responseB },
      grant: grantFor(ALPHA_ID, WORK_B_ID, "work-b"),
    };
    await core.read(
      { file: "alpha.md", documentId: ALPHA_ID },
      { ...contextB, responseIdentity: undefined },
    );
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "green",
          content: "emerald",
          tool_use_id: "w-b",
        },
        contextB,
      ),
    ).toMatchObject({ phase: "staged" });
    expect(await write("green", "lime", "w-a")).toMatchObject({ phase: "staged" });
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, EDIT]]);
    expect(refused(await harness.commit(responseB))).toEqual([]);
    const beta = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_B_ID);
    beta.doc.destroy();
    expect(await fixture.draftMarkdown(beta.branchId)).toBe("red\n\nblue\n\nemerald\n");
    // A later reply writes the document again, through a fresh peer on the reset branch.
    const next = await createResponse(db, 3);
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "blue",
          content: "navy",
          tool_use_id: "w-later",
        },
        responseContext(next),
      ),
    ).toMatchObject({ phase: "staged" });
    expect(refused(await harness.commit(next))).toEqual([]);
    const mine = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    mine.doc.destroy();
    expect(await fixture.draftMarkdown(mine.branchId)).toBe("red\n\nnavy\n\ngreen\n");
  });
});
