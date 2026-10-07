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

it.each([
  "created-parent",
  "surviving-text",
] as const)("refuses stale Discard when %s dependency arrives after the displayed preview", async (shape) => {
  const harness = createHarness();
  try {
    await harness.seedWriterDocument("Alpha base.", "discard-arrival");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    async function stage(source: "agent" | "writer") {
      const staged = await f.branchCoordinator.readBranch(
        branch.branchId,
        async (doc, snapshot) => {
          const clone = createCollabYDoc({ gc: false });
          Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
          return { clone, generation: snapshot.generation };
        },
      );
      try {
        const fragment = staged.clone.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        if (shape === "created-parent" && source === "agent") {
          const paragraph = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          text.insert(0, "AI block.");
          paragraph.insert(0, [text]);
          fragment.insert(1, [paragraph]);
        } else {
          const paragraph = fragment.get(shape === "created-parent" ? 1 : 0) as Y.XmlElement;
          const text = paragraph.get(0) as Y.XmlText;
          text.insert(
            source === "agent" ? text.length : 12 > text.length ? text.length : 12,
            source === "agent" ? "ABC" : "X",
          );
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
    await stage("agent");
    const command = {
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
    };
    const preview = await f.collab.draftReview.preview(command);
    if (preview.status !== "active") throw new Error("missing preview");
    // Deterministic admission between the writer's displayed cut and command commit.
    await stage("writer");
    const arrived = await f.collab.draftReview.preview(command);
    if (arrived.status !== "active") throw new Error("missing arrival preview");
    const request = {
      ...command,
      operationIds: preview.operations.map((op) => op.operationId),
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
    };
    expect(await f.collab.draftReview.discardWorkDraft(request)).toEqual({
      status: "stale",
      draftId: branch.branchId,
    });
    const after = await f.collab.draftReview.preview(command);
    expect(after).toMatchObject({
      status: "active",
      markdown: arrived.markdown,
      draftRevisionToken: arrived.draftRevisionToken,
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha base.\n");
    const refreshed = {
      ...command,
      operationIds: arrived.operations.map((op) => op.operationId),
      liveRevisionToken: arrived.liveRevisionToken,
      draftRevisionToken: arrived.draftRevisionToken,
    };
    expect(await f.collab.draftReview.discardWorkDraft(refreshed)).toMatchObject({
      status: "discarded",
      draftClosed: true,
    });
  } finally {
    harness.destroyWarmState();
  }
});
