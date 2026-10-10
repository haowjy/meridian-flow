/** Durable regressions for complete-effect settlement and preview-scoped Discard. */

import { toDocHandle } from "@meridian/agent-edit/integration";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetSettlementFixture,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import { THREAD_ID, WORK_ID } from "./test-support/change-trail-postgres-harness.js";
import { commitBranchEdit, fencedRequest } from "./test-support/draft-review-requests.js";

const db = createTestDatabase();
beforeEach(() => resetSettlementFixture(db));
afterAll(() => closeDatabase(db));
it.each([
  "apply",
  "discard",
] as const)("retains independent formatting after final text %s", async (action) => {
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("Alpha base.\n\nBeta base.", "format-loss");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    for (const source of ["agent", "writer"] as const) {
      await commitBranchEdit(f, branch.branchId, { source }, (doc) => {
        if (source === "agent") {
          const b = f.model.getBlocks(toDocHandle(doc))[0];
          f.model.applyTextEdit(toDocHandle(doc), b, { from: 11, to: 11 }, " Agent");
        } else {
          const para = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(1) as Y.XmlElement;
          (para.get(0) as Y.XmlText).format(0, 4, { strong: {} });
        }
      });
    }
    const cmd = {
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
    };
    const preview = await f.collab.draftReview.preview(cmd);
    if (preview.status !== "active") throw Error("missing preview");
    expect(await f.draftMarkdown(branch.branchId)).toContain("**Beta**");
    const result = await (action === "apply"
      ? f.collab.draftReview.applyWorkDraftChanges
      : f.collab.draftReview.discardWorkDraft)(
      fencedRequest(
        cmd,
        preview,
        preview.operations.map((op) => op.operationId),
      ),
    );
    const after = await f.collab.draftReview.preview(cmd);
    if (after.status !== "active") throw Error("missing after");
    expect(result).toMatchObject({
      status: action === "apply" ? "applied" : "discarded",
      draftClosed: false,
    });
    expect(await f.draftMarkdown(branch.branchId)).toContain("**Beta**");
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
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("Alpha base.", "discard-arrival");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    async function stage(source: "agent" | "writer") {
      await commitBranchEdit(f, branch.branchId, { source }, (doc) => {
        const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
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
      });
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
    const request = fencedRequest(
      command,
      preview,
      preview.operations.map((op) => op.operationId),
    );
    expect(await f.collab.draftReview.discardWorkDraft(request)).toEqual({
      status: "stale",
      draftId: branch.branchId,
    });
    const after = await f.collab.draftReview.preview(command);
    expect(after).toMatchObject({
      status: "active",
      draftRevisionToken: arrived.draftRevisionToken,
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha base.\n");
    const refreshed = fencedRequest(
      command,
      arrived,
      arrived.operations.map((op) => op.operationId),
    );
    expect(await f.collab.draftReview.discardWorkDraft(refreshed)).toMatchObject({
      status: "discarded",
      draftClosed: true,
    });
  } finally {
    harness.destroyWarmState();
  }
});

it("keeps incomplete attribution document-only and whole Apply still publishes its full effect", async () => {
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("Alpha stays.", "missing-removal-owner");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    for (const edit of ["insert", "remove"] as const) {
      await commitBranchEdit(f, branch.branchId, { source: "agent" }, (doc) => {
        const block = f.model.getBlocks(toDocHandle(doc))[0];
        f.model.applyTextEdit(
          toDocHandle(doc),
          block,
          edit === "insert" ? { from: 0, to: 0 } : { from: 4, to: 9 },
          edit === "insert" ? "New " : "",
        );
      });
    }
    // Fault-inject missing attribution evidence while preserving the persisted effect.
    const rows = await f.db.select().from(f.schema.branchWriteJournal);
    const removal = rows.sort((a, b) => b.id - a.id)[0];
    await f.db
      .update(f.schema.branchWriteJournal)
      .set({ status: "discarded" })
      .where(eq(f.schema.branchWriteJournal.id, removal.id));
    const command = {
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
    };
    const preview = await f.collab.draftReview.preview(command);
    if (preview.status !== "active") throw new Error("missing preview");
    expect(preview.hunks[0]).toMatchObject({
      unclassified: true,
      deletedText: "Alpha",
      deletedSpans: [],
    });
    expect(preview.operations[0]).toMatchObject({ canApplyOrDiscard: false });
    const request = fencedRequest(
      command,
      preview,
      preview.operations.map((op) => op.operationId),
    );
    expect(await f.collab.draftReview.applyWorkDraftChanges(request)).toMatchObject({
      status: "incomplete_class",
    });
    expect(await f.collab.draftReview.discardWorkDraft(request)).toMatchObject({
      status: "incomplete_class",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha stays.\n");
    expect(await f.collab.draftReview.applyWorkDraft(command)).toMatchObject({ status: "applied" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("New  stays.\n");
  } finally {
    harness.destroyWarmState();
  }
});
