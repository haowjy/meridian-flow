/** Durable regressions for complete-effect settlement and preview-scoped Discard. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseDraftDiscardSelection } from "../../lib/draft-review-route.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetSettlementFixture,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import { THREAD_ID, TURN_ID, WORK_ID } from "./test-support/change-trail-postgres-harness.js";

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
    expect(await f.draftMarkdown(branch.branchId)).toContain("**Beta**");
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

it("keeps incomplete attribution document-only and whole Apply still publishes its full effect", async () => {
  const harness = createHarness(db);
  try {
    await harness.seedWriterDocument("Alpha stays.", "missing-removal-owner");
    const f = harness.crossWorkProbeFixture();
    const branch = await f.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    for (const edit of ["insert", "remove"] as const) {
      const staged = await f.branchCoordinator.readBranch(
        branch.branchId,
        async (doc, snapshot) => {
          const clone = createCollabYDoc({ gc: false });
          Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
          return { clone, generation: snapshot.generation };
        },
      );
      try {
        const block = f.model.getBlocks(toDocHandle(staged.clone))[0];
        f.model.applyTextEdit(
          toDocHandle(staged.clone),
          block,
          edit === "insert" ? { from: 0, to: 0 } : { from: 4, to: 9 },
          edit === "insert" ? "New " : "",
        );
        await f.branchCoordinator.commitSyncFromDoc({
          branchId: branch.branchId,
          sourceDoc: staged.clone,
          expectedGeneration: staged.generation,
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
        });
      } finally {
        staged.clone.destroy();
      }
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
    const request = {
      ...command,
      operationIds: preview.operations.map((op) => op.operationId),
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
    };
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

describe("Discard request selection", () => {
  it.each([
    [],
    [123],
    ["valid", 123],
    null,
    "valid",
    [""],
  ])("rejects malformed selection %j", (ids) => {
    expect(() => parseDraftDiscardSelection({ operationIds: ids })).toThrow();
  });
  it("reserves whole Discard for a genuinely absent selection", () => {
    expect(parseDraftDiscardSelection({})).toEqual({ status: "ready", command: {} });
    expect(() => parseDraftDiscardSelection({ liveRevisionToken: "live" })).toThrow();
  });
  it("refuses missing selective revisions as stale", () => {
    expect(parseDraftDiscardSelection({ operationIds: ["1"] })).toEqual({ status: "stale" });
  });
  it("keeps the complete typed selective command", () => {
    const command = { operationIds: ["1"], liveRevisionToken: "live", draftRevisionToken: "draft" };
    expect(parseDraftDiscardSelection(command)).toEqual({ status: "ready", command });
  });
});
