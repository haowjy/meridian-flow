/** A settled draft must not return through the same chat's retained Yjs peer. */
import { afterAll, beforeEach, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetSettlementFixture,
} from "./test-support/branch-push-settlement-fixture.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";

const db = createTestDatabase();
beforeEach(() => resetSettlementFixture(db));
afterAll(() => closeDatabase(db));

it.each([
  "replacement",
  "deletion",
] as const)("keeps a per-change apply of a %s settled when the same chat writes and whole Applies again", async (effect) => {
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("The sacred dawn.", "review-reopen");
    const f = harness.crossWorkProbeFixture();
    await harness.stageCertifiedReplace({
      responseId: "reopen-first",
      find: "sacred ",
      content: effect === "replacement" ? "ruined " : "",
    });
    const review = reviewDriver(f.collab.draftReview);
    const preview = await review.activePreview(ALPHA_ID);
    expect(await review.applyChanges(ALPHA_ID, preview)).toMatchObject({
      status: "applied",
      itemClosed: true,
    });
    const adjective = effect === "replacement" ? "ruined " : "";
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(`The ${adjective}dawn.\n`);
    const reopenedId = await harness.stageCertifiedReplace({
      responseId: "reopen-second",
      find: "dawn",
      content: "dusk",
    });
    const nextPreview = await review.preview(ALPHA_ID);
    const nextDraft = await f.draftMarkdown(reopenedId);
    expect(await review.applyItem(ALPHA_ID)).toMatchObject({
      status: "applied",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(`The ${adjective}dusk.\n`);
    expect(nextPreview.status).toBe("active");
    expect(nextDraft).toBe(`The ${adjective}dusk.\n`);
  } finally {
    harness.destroyWarmState();
  }
});
