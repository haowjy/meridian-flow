// Revocable response helpers and accepted replay.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
} from "../test-support/change-trail-postgres-harness.js";
import { setupResponseDraft } from "../test-support/document-edit-receipt-fixture.js";
import { reviewDriver } from "../test-support/draft-review-requests.js";

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
    expect(await reviewDriver(fixture.collab.draftReview).discardAll()).toMatchObject({
      status: "discarded",
    });
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
});
