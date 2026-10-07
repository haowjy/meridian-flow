/** Durable regressions for complete-effect settlement and preview-scoped Discard. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  ALPHA_ID,
  createHarness,
  setupSettlementFixture,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import { THREAD_ID, TURN_ID, WORK_ID } from "./test-support/change-trail-postgres-harness.js";

setupSettlementFixture();
it.each([
  "apply",
  "discard",
] as const)("retains independent formatting after final text %s", async (action) => {
  const harness = createHarness();
  try {
    await harness.seedWriterDocument("Alpha base.\n\nBeta base.", "format-loss");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    for (const source of ["agent", "writer"] as const) {
      const staged = await f.branchCoordinator.readBranch(
        branch.branchId,
        async (doc, snapshot) => {
          const clone = createCollabYDoc({ gc: false });
          Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
          return { clone, generation: snapshot.generation };
        },
      );
      try {
        if (source === "agent") {
          const b = f.model.getBlocks(toDocHandle(staged.clone))[0];
          f.model.applyTextEdit(toDocHandle(staged.clone), b, { from: 11, to: 11 }, " Agent");
        } else {
          const para = staged.clone
            .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
            .get(1) as Y.XmlElement;
          (para.get(0) as Y.XmlText).format(0, 4, { strong: {} });
        }
        await f.branchCoordinator.commitSyncFromDoc({
          branchId: branch.branchId,
          sourceDoc: staged.clone,
          expectedGeneration: staged.generation,
          source,
          actorUserId: source === "writer" ? USER_ID : null,
          threadId: THREAD_ID,
          turnId: source === "agent" ? TURN_ID : null,
          wId: null,
          updateMeta: null,
        });
      } finally {
        staged.clone.destroy();
      }
    }
    const cmd = {
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
    };
    const preview = await f.collab.draftReview.preview(cmd);
    if (preview.status !== "active") throw Error("missing preview");
    expect(preview.markdown).toContain("**Beta**");
    const result = await (action === "apply"
      ? f.collab.draftReview.applyWorkDraftChanges
      : f.collab.draftReview.discardWorkDraft)({
      ...cmd,
      operationIds: preview.operations.map((op) => op.operationId),
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
    });
    const after = await f.collab.draftReview.preview(cmd);
    if (after.status !== "active") throw Error("missing after");
    expect(result).toMatchObject({
      status: action === "apply" ? "applied" : "discarded",
      draftClosed: false,
    });
    expect(after.markdown).toContain("**Beta**");
    expect(await harness.liveMarkdown(ALPHA_ID)).not.toContain("**Beta**");
    expect(await f.collab.draftReview.list({ workId: WORK_ID })).toHaveLength(1);
  } finally {
    harness.destroyWarmState();
  }
});
