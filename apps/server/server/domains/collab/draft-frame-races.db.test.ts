/**
 * A writer frame acquires nothing (lock-free branches, phase 1b): it judges against its committed
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
import { readDraftAt } from "./adapters/drizzle-draft-storage.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";
import { ReversalConflictError } from "./domain/reversal-conflict.js";
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
import { draftContent } from "./test-support/draft-store-seam.js";
import { inverseFixture, readDraftId } from "./test-support/turn-inverse-fixture.js";

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
  async function writerFrame(draftId: string, edit: (fragment: Y.XmlFragment) => void) {
    const [documentDraft] = await db
      .select({ generation: schema.documentDrafts.generation })
      .from(schema.documentDrafts)
      .where(eq(schema.documentDrafts.id, draftId));
    if (!documentDraft) throw new Error(`Draft ${draftId} does not exist`);
    const room = new Y.Doc({ gc: false });
    Y.applyUpdate(room, await draftContent(db, draftId));
    room.clientID = allocateDocumentClient(room);
    const updates = captureMutationUpdates(room, () => edit(room.getXmlFragment("prosemirror")));
    return {
      send: () =>
        fixture.view.draftCoordinator.commitWriterUpdate({
          draftId,
          expectedGeneration: documentDraft.generation,
          updateData: Y.mergeUpdates(updates),
          actorUserId: USER_ID as never,
          roomDocument: room,
        }),
      destroy: () => room.destroy(),
    };
  }

  async function writerRows(draftId: string) {
    return db
      .select({ id: schema.draftWriteJournal.id })
      .from(schema.draftWriteJournal)
      .where(
        and(
          eq(schema.draftWriteJournal.draftId, draftId),
          eq(schema.draftWriteJournal.source, "writer"),
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
    return readDraftId(db, ALPHA_ID);
  }

  /** The draft holds one AI change; the writer then edits live, so a pull has work. */
  async function draftBehindLive(): Promise<string> {
    const { harness, view } = fixture;
    const draftId = await draftWithChange();
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
    return draftId;
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
    const draftId = await draftBehindLive();
    const frame = await writerFrame(draftId, appendParagraph("Extra."));
    const pull = () => fixture.view.draftPulls.flushLivePull(ALPHA_ID);
    try {
      const run =
        first === "pull"
          ? // The pull holds the branch row between its checkpoint UPDATE and COMMIT.
            await interleave(db, pull, "draft.rewrite.beforeCommit", frame.send)
          : await interleave(db, frame.send, "draft.append.afterCommit", pull);
      const sent = (first === "pull" ? run.b : run.a) as Settled<{ admitted: boolean }>;
      expect(sent).toEqual({ ok: true, value: { admitted: true } });
      expect(first === "pull" ? run.a : run.b).toMatchObject({ ok: true });
      // The frame's append waited on the rewrite's row lock, then judged against the result.
      if (first === "pull") expect(run.bWaited).toBe(true);
    } finally {
      frame.destroy();
    }
    expect(await fixture.view.draftMarkdown(draftId)).toBe(
      "Live Alpha Gamma.\n\nBlue.\n\nExtra.\n",
    );
    const rows = await writerRows(draftId);
    expect(rows).toHaveLength(1);
    const read = await readDraftAt(db, draftId);
    const [row] = rows;
    if (!read || !row) throw new Error("the branch or its frame row is missing");
    // Either re-judged after the checkpoint (in the tail) or folded into it, never both.
    if (first === "pull") {
      expect(read.documentDraft.checkpointSeq).toBeLessThan(row.id);
      expect(read.tail.map((tail) => tail.id)).toContain(row.id);
    } else {
      expect(read.documentDraft.checkpointSeq).toBeGreaterThanOrEqual(row.id);
      expect(read.tail.map((tail) => tail.id)).not.toContain(row.id);
    }
  });

  /** A created document's fresh draft branch, with no contribution yet. */
  async function createdDocumentDraft(): Promise<{ draftId: string; branchId: string }> {
    const [draft] = await db
      .select({ id: schema.branches.id })
      .from(schema.branches)
      .where(eq(schema.branches.originWorkId, WORK_ID));
    if (!draft) throw new Error("the Work has no draft");
    await fixture.view.draftStore.ensureCreatedDocumentDraft({
      documentId: ALPHA_ID,
      branchId: draft.id as never,
    });
    return { draftId: await readDraftId(db, ALPHA_ID), branchId: draft.id };
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
    const { draftId, branchId } = await createdDocumentDraft();
    const frame = await writerFrame(draftId, typedAndErased);
    const retract = () =>
      runInDrizzleTransaction(db, () =>
        fixture.view.draftStore.retractCreatedDocumentDraft({
          documentId: ALPHA_ID,
          branchId: branchId as never,
        }),
      );
    try {
      if (first === "frame") {
        // Paused after its unlocked read found no contribution; the frame commits meanwhile.
        const run = await interleave(db, retract, "retract.beforeLocks", frame.send);
        expect(run.b).toEqual({ ok: true, value: { admitted: true } });
        expect(run.a).toEqual({ ok: true, value: { outcome: "stands" } });
        expect(await writerRows(draftId)).toHaveLength(1);
      } else {
        // The retraction holds the rows and found nothing; the frame's append waits on them.
        const run = await interleave(db, retract, "retract.afterRecheck", frame.send);
        expect(run.bWaited).toBe(true);
        expect(run.a).toMatchObject({ ok: true, value: { outcome: "retracted" } });
        expect(run.b.ok && run.b.value.admitted).toBe(false);
        expect(await readDraftAt(db, draftId)).toBeNull();
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
    draftId: string,
    last: (fragment: Y.XmlFragment) => void,
  ): Promise<{ commits: () => number; remove: () => void }> {
    let commits = 0;
    const remove = setCollabHook("inverse.beforeCommitScope", async () => {
      commits += 1;
      const frame = await writerFrame(draftId, commits === 4 ? last : typedAndErased);
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
    const draftId = await draftWithChange();
    const frames = await framesBeforeEveryCommit(draftId, typedAndErased);
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
    expect(await fixture.view.draftMarkdown(draftId)).toBe("Alpha Gamma.\n\nBlue.\n");
  });

  it("an inverse whose last capture finds its part retyped answers with that plan's reasons", async () => {
    const draftId = await draftWithChange();
    const frames = await framesBeforeEveryCommit(draftId, retype("Alpha Delta."));
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
    expect(await fixture.view.draftMarkdown(draftId)).toBe("Alpha Delta.\n\nBlue.\n");
  });
});
