/**
 * Contract §2.6 DB cases: what a reply's staged writes become when the writer's Discard, Apply
 * or an archive lands before the save. A refusal is a receipt, never a thrown save.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  THREAD_ID,
} from "./test-support/change-trail-postgres-harness.js";
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
});
