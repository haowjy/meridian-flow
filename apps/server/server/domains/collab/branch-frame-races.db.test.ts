/**
 * A writer frame takes no lease (lock-free drafts, phase 1b): it judges against its published
 * replica and appends under its revision predicate. These races pin the two doors a frame can
 * reach mid-transaction: a pull's rewrite holding the branch row, and a created document's
 * retraction (F3); and an inverse every one of whose attempts a frame moves (F5).
 */
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { interleave, type Settled } from "../../test-support/lock-interleave.js";
import { readBranchAt } from "./adapters/drizzle-branch-storage.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";
import { ReversalConflictError } from "./domain/reversal-conflict.js";
import { branchContent } from "./test-support/branch-store-seam.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { draftBranchId, inverseFixture } from "./test-support/turn-inverse-fixture.js";

type Fixture = Awaited<ReturnType<typeof inverseFixture>>;

describe("writer frames racing rewrites (postgres)", () => {
  const db = createTestDatabase();
  let fixture: Fixture;
  beforeEach(async () => {
    await resetDatabase(db);
    fixture = await inverseFixture(db);
  });
  afterEach(() => {
    fixture.harness.cancelScheduledPulls();
    fixture.harness.destroyWarmState();
  });
  afterAll(() => closeDatabase(db));

  /**
   * A frame from a room holding the branch as it is now: `edit` runs on the room's copy and
   * the frame carries exactly the update it made.
   */
  async function writerFrame(branchId: string, edit: (fragment: Y.XmlFragment) => void) {
    const [branch] = await db
      .select({ generation: schema.documentBranches.generation })
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.id, branchId));
    if (!branch) throw new Error(`Branch ${branchId} does not exist`);
    const room = new Y.Doc({ gc: false });
    Y.applyUpdate(room, await branchContent(db, branchId));
    room.clientID = allocateDocumentClient(room);
    const updates = captureMutationUpdates(room, () => edit(room.getXmlFragment("prosemirror")));
    return {
      send: () =>
        fixture.view.branchCoordinator.commitWriterUpdate({
          branchId,
          expectedGeneration: branch.generation,
          updateData: Y.mergeUpdates(updates),
          actorUserId: USER_ID as never,
          roomDocument: room,
        }),
      destroy: () => room.destroy(),
    };
  }

  async function writerRows(branchId: string) {
    return db
      .select({ id: schema.branchWriteJournal.id })
      .from(schema.branchWriteJournal)
      .where(
        and(
          eq(schema.branchWriteJournal.branchId, branchId),
          eq(schema.branchWriteJournal.source, "writer"),
        ),
      );
  }

  /** The draft holds one AI change: "Beta" became "Gamma". */
  async function draftWithChange(): Promise<string> {
    const { harness, view, responseId, context } = fixture;
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "draft",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    harness.cancelScheduledPulls();
    return draftBranchId(db, ALPHA_ID);
  }

  /** The draft holds one AI change; the writer then edits live, so a pull has work. */
  async function draftBehindLive(): Promise<string> {
    const { harness, view } = fixture;
    const branchId = await draftWithChange();
    await view.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      const block = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).insert(0, "Live ");
      await view.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    harness.cancelScheduledPulls();
    return branchId;
  }

  const appendParagraph = (text: string) => (fragment: Y.XmlFragment) => {
    const paragraph = new Y.XmlElement("paragraph");
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    fragment.insert(fragment.length, [paragraph]);
  };

  it.each([
    "pull",
    "frame",
  ] as const)("a frame and a pull's rewrite (%s first) land the frame exactly once, as serialized", async (first) => {
    const branchId = await draftBehindLive();
    const frame = await writerFrame(branchId, appendParagraph("Extra."));
    const pull = () => fixture.view.branchPulls.flushLivePull(ALPHA_ID);
    try {
      const run =
        first === "pull"
          ? // The pull holds the branch row between its checkpoint UPDATE and COMMIT.
            await interleave(db, pull, "branch.rewrite.beforeCommit", frame.send)
          : await interleave(db, frame.send, "branch.append.afterCommit", pull);
      const sent = (first === "pull" ? run.b : run.a) as Settled<{ admitted: boolean }>;
      expect(sent).toEqual({ ok: true, value: { admitted: true } });
      expect(first === "pull" ? run.a : run.b).toMatchObject({ ok: true });
      // The frame's append waited on the rewrite's row lock, then judged against the result.
      if (first === "pull") expect(run.bWaited).toBe(true);
    } finally {
      frame.destroy();
    }
    expect(await fixture.view.draftMarkdown(branchId)).toBe(
      "Live Alpha Gamma.\n\nBlue.\n\nExtra.\n",
    );
    const rows = await writerRows(branchId);
    expect(rows).toHaveLength(1);
    const read = await readBranchAt(db, branchId);
    const [row] = rows;
    if (!read || !row) throw new Error("the branch or its frame row is missing");
    // Either re-judged after the checkpoint (in the tail) or folded into it, never both.
    if (first === "pull") {
      expect(read.branch.checkpointSeq).toBeLessThan(row.id);
      expect(read.tail.map((tail) => tail.id)).toContain(row.id);
    } else {
      expect(read.branch.checkpointSeq).toBeGreaterThanOrEqual(row.id);
      expect(read.tail.map((tail) => tail.id)).not.toContain(row.id);
    }
  });

  /** A created document's fresh draft branch, with no contribution yet. */
  async function createdDraftBranch(): Promise<{ branchId: string; draftId: string }> {
    const [draft] = await db
      .select({ id: schema.drafts.id })
      .from(schema.drafts)
      .where(eq(schema.drafts.originWorkId, WORK_ID));
    if (!draft) throw new Error("the Work has no draft");
    await fixture.view.branchStore.ensureCreatedDraftBranch({
      documentId: ALPHA_ID,
      draftId: draft.id as never,
    });
    return { branchId: await draftBranchId(db, ALPHA_ID), draftId: draft.id };
  }

  /** Novel clocks, no visible effect: a character typed and erased in one frame. */
  const typedAndErased = (fragment: Y.XmlFragment) => {
    const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, "x");
    text.delete(0, 1);
  };

  it.each([
    "frame",
    "retraction",
  ] as const)("a created document's retraction and a frame (%s commits first) never lose the frame silently", async (first) => {
    const { branchId, draftId } = await createdDraftBranch();
    const frame = await writerFrame(branchId, typedAndErased);
    const retract = () =>
      runInDrizzleTransaction(db, () =>
        fixture.view.branchStore.retractCreatedDraftBranch({
          documentId: ALPHA_ID,
          draftId: draftId as never,
        }),
      );
    try {
      if (first === "frame") {
        // Paused after its unlocked read found no contribution; the frame commits meanwhile.
        const run = await interleave(db, retract, "retract.beforeLocks", frame.send);
        expect(run.b).toEqual({ ok: true, value: { admitted: true } });
        expect(run.a).toEqual({ ok: true, value: { outcome: "stands" } });
        expect(await writerRows(branchId)).toHaveLength(1);
      } else {
        // The retraction holds the rows and found nothing; the frame's append waits on them.
        const run = await interleave(db, retract, "retract.afterRecheck", frame.send);
        expect(run.bWaited).toBe(true);
        expect(run.a).toMatchObject({ ok: true, value: { outcome: "retracted" } });
        expect(run.b.ok && run.b.value.admitted).toBe(false);
        expect(await readBranchAt(db, branchId)).toBeNull();
      }
    } finally {
      frame.destroy();
    }
  });

  /** Replaces the first paragraph's text in one writer frame. */
  const retype = (text: string) => (fragment: Y.XmlFragment) => {
    const content = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    content.delete(0, content.length);
    content.insert(0, text);
  };

  /**
   * Every one of the inverse's four commit attempts meets a writer frame that moved the draft
   * after its capture; `last` is the frame before the fourth commit.
   */
  async function framesBeforeEveryCommit(
    branchId: string,
    last: (fragment: Y.XmlFragment) => void,
  ): Promise<{ commits: () => number; remove: () => void }> {
    let commits = 0;
    const remove = setCollabHook("inverse.beforeCommitScope", async () => {
      commits += 1;
      const frame = await writerFrame(branchId, commits === 4 ? last : typedAndErased);
      try {
        expect(await frame.send()).toEqual({ admitted: true });
      } finally {
        frame.destroy();
      }
    });
    return { commits: () => commits, remove };
  }

  const modelUndo = () =>
    fixture.view.collab.agentEdit().write(
      { command: "undo", documentId: ALPHA_ID, file: "alpha.md" },
      {
        ...fixture.context,
        responseIdentity: {
          providerResponseId: fixture.responseId,
          editScopeId: fixture.responseId,
        },
      },
    );
  const cardUndo = () =>
    fixture.view.collab.reverseTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "undo",
      actor: { type: "user", userId: USER_ID },
    });

  it.each([
    "model",
    "card",
  ] as const)("an inverse (%s) whose four attempts all miss while its part still applies is a conflict, never a refusal", async (door) => {
    const branchId = await draftWithChange();
    const frames = await framesBeforeEveryCommit(branchId, typedAndErased);
    try {
      if (door === "model") {
        const undone = await modelUndo();
        expect(undone).toMatchObject({ status: "internal_error" });
        expect(JSON.stringify(undone)).toContain("the draft changed while reversing; try again");
      } else {
        await expect(cardUndo()).rejects.toBeInstanceOf(ReversalConflictError);
      }
    } finally {
      frames.remove();
    }
    // Four commits, each unwound; the classification pass never writes.
    expect(frames.commits()).toBe(4);
    expect(await fixture.view.draftMarkdown(branchId)).toBe("Alpha Gamma.\n\nBlue.\n");
  });

  it("an inverse whose last capture finds its part retyped answers with that plan's reasons", async () => {
    const branchId = await draftWithChange();
    const frames = await framesBeforeEveryCommit(branchId, retype("Alpha Delta."));
    try {
      expect(await cardUndo()).toMatchObject({
        status: "expired",
        acceptedParts: 0,
        skips: [expect.objectContaining({ reason: "Stayed as you edited it" })],
      });
    } finally {
      frames.remove();
    }
    expect(frames.commits()).toBe(4);
    expect(await fixture.view.draftMarkdown(branchId)).toBe("Alpha Delta.\n\nBlue.\n");
  });
});
