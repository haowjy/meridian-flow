/** A settled draft must not return through the same chat's retained Yjs peer. */
import { expect, it } from "vitest";
import {
  ALPHA_ID,
  createHarness,
  setupSettlementFixture,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import { WORK_ID } from "./test-support/change-trail-postgres-harness.js";

setupSettlementFixture();

it.each([
  { action: "discard", effect: "replacement" },
  { action: "apply", effect: "replacement" },
  { action: "discard", effect: "deletion" },
  { action: "apply", effect: "deletion" },
] as const)("keeps a per-change $action of a $effect settled when the same chat writes and whole Applies again", async ({
  action,
  effect,
}) => {
  const harness = createHarness();
  try {
    await harness.seedWriterDocument("The sacred dawn.", "review-reopen");
    const f = harness.crossWorkProbeFixture();
    const draftId = await harness.stageCertifiedReplace({
      responseId: "reopen-first",
      find: "sacred ",
      content: effect === "replacement" ? "ruined " : "",
    });
    const command = { workId: WORK_ID, documentId: ALPHA_ID, draftId, userId: USER_ID };
    const preview = await f.collab.draftReview.preview(command);
    if (preview.status !== "active") throw new Error("missing preview");
    const selection = {
      ...command,
      operationIds: preview.operations.map((op) => op.operationId),
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
    };
    expect(
      await (action === "discard"
        ? f.collab.draftReview.discardWorkDraft(selection)
        : f.collab.draftReview.applyWorkDraftChanges(selection)),
    ).toMatchObject({ status: action === "discard" ? "discarded" : "applied", draftClosed: true });
    const adjective = action === "discard" ? "sacred " : effect === "replacement" ? "ruined " : "";
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(`The ${adjective}dawn.\n`);
    const reopenedId = await harness.stageCertifiedReplace({
      responseId: "reopen-second",
      find: "dawn",
      content: "dusk",
    });
    const reopened = { ...command, draftId: reopenedId };
    const nextPreview = await f.collab.draftReview.preview(reopened);
    expect(await f.collab.draftReview.applyWorkDraft(reopened)).toMatchObject({
      status: "applied",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(`The ${adjective}dusk.\n`);
    expect(nextPreview).toMatchObject({ status: "active", markdown: `The ${adjective}dusk.\n` });
  } finally {
    harness.destroyWarmState();
  }
});
