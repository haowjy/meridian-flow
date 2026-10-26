/**
 * A writer frame acquires nothing (lock-free drafts, phase 1b): it judges against its committed replica and appends under its draft row hold.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - committed-prefix server authorship, deferred replica installation, and four-attempt inverse retries (kb/decisions/collab/drafts/model/shared-branch-per-work.md)
 */

import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { setTestHook } from "../../shared/test-hooks.js";
import { interleave, type Settled } from "../../test-support/lock-interleave.js";
import { readDraftAt } from "./adapters/drizzle-draft-storage.js";
import { createDraftRuntime } from "./domain/draft-runtime.js";
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
  afterEach(async () => {
    await fixture.harness.dispose();
  });
  afterAll(() => closeDatabase(db));

  /**
   * A frame from a room holding the draft as it is now: `edit` runs on the room's copy and
   * the frame carries exactly the update it made.
   */
  async function writerFrame(draftId: string, edit: (fragment: Y.XmlFragment) => void) {
    const room = new Y.Doc({ gc: false });
    Y.applyUpdate(room, await draftContent(db, draftId));
    room.clientID = allocateDocumentClient(room);
    const updates = captureMutationUpdates(room, () => edit(room.getXmlFragment("prosemirror")));
    return {
      send: () =>
        fixture.view.draftCoordinator.commitWriterUpdate({
          draftId,
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

  it("authors server rows on the locked prefix without client-1 clock collisions, installing only after root commit", async () => {
    const draftId = await draftWithChange();
    const delivered: Uint8Array[] = [];
    const dirty: string[] = [];
    const runtime = createDraftRuntime({
      store: fixture.view.draftStore,
      onAppendCommitted: (id) => dirty.push(id),
      onDraftUpdate: ({ update }) => delivered.push(update),
    });
    const base = await runtime.loadBase(draftId);
    const serverAppend = (text: string) =>
      runtime.prepareAppend(base, [], {
        authorServerRows: (prefix) =>
          captureMutationUpdates(prefix, () => {
            appendParagraph(text)(prefix.getXmlFragment("prosemirror"));
          }),
      });
    // Both are prepared from the same replica. Neither allocates client-1 clocks yet.
    const first = serverAppend("Server one.");
    const second = serverAppend("Server two.");
    try {
      await runInDrizzleTransaction(db, async () => {
        expect(await first.persist()).toBe(true);
        first.transfer();
        expect(runtime.committed(draftId)).toBe(base.replica);
        expect(delivered).toHaveLength(0);
        expect(dirty).toHaveLength(0);
      });
      expect(runtime.committed(draftId)?.revision).toBeGreaterThan(base.replica.revision);
      expect(delivered).toHaveLength(1);
      const installed = runtime.committed(draftId);
      const rolledBack = serverAppend("Must roll back.");
      try {
        await expect(
          runInDrizzleTransaction(db, async () => {
            await rolledBack.persist();
            rolledBack.transfer();
            throw new Error("Abort the root after savepoint release");
          }),
        ).rejects.toThrow("Abort the root");
      } finally {
        rolledBack.dispose();
      }
      expect(runtime.committed(draftId)).toBe(installed);
      expect(delivered).toHaveLength(1);
      expect(dirty).toHaveLength(1);
      await runtime.commitOnce(second, {});
    } finally {
      first.dispose();
      second.dispose();
    }
    const writer = await writerFrame(draftId, appendParagraph("Writer first."));
    let sawWriter = false;
    const third = runtime.prepareAppend(base, [], {
      authorServerRows: (prefix) => {
        sawWriter = prefix.getXmlFragment("prosemirror").toString().includes("Writer first.");
        return captureMutationUpdates(prefix, () =>
          appendParagraph("Server three.")(prefix.getXmlFragment("prosemirror")),
        );
      },
    });
    try {
      const raced = await interleave(db, writer.send, "draft.append.beforeCommit", () =>
        runtime.commitOnce(third, {}),
      );
      expect(raced.a).toEqual({ ok: true, value: { admitted: true } });
      expect(raced.b).toEqual({ ok: true, value: true });
      expect(raced.bWaited).toBe(true);
      expect(sawWriter).toBe(true);
    } finally {
      third.dispose();
      writer.destroy();
    }
    const rows = await db
      .select()
      .from(schema.draftWriteJournal)
      .where(
        and(
          eq(schema.draftWriteJournal.draftId, draftId),
          eq(schema.draftWriteJournal.source, "server"),
        ),
      )
      .orderBy(schema.draftWriteJournal.id);
    expect(rows).toHaveLength(3);
    let end = Y.decodeStateVector(Y.encodeStateVector(base.replica.doc)).get(1) ?? 0;
    for (const row of rows) {
      const structs = Y.decodeUpdate(row.updateData).structs;
      expect(structs.length).toBeGreaterThan(0);
      expect(structs.every((struct) => struct.id.client === 1)).toBe(true);
      expect(structs[0].id.clock).toBe(end);
      end = Math.max(...structs.map((struct) => struct.id.clock + struct.length));
      const receipts = await db.select().from(schema.documentEditParts).where(
        // Every server row has its own immutable receipt, not a synthetic writer receipt.
        sql`origin->>'draftId' = ${draftId} AND (origin->>'rowId')::int = ${row.id}`,
      );
      expect(receipts).toHaveLength(1);
    }
    const text = await fixture.view.draftMarkdown(draftId);
    expect(text).toBe(
      "Alpha Gamma.\n\nBlue.\n\nServer one.\n\nServer two.\n\nWriter first.\n\nServer three.\n",
    );
    expect(runtime.committed(draftId)?.doc.getXmlFragment("prosemirror").toString()).toContain(
      "Server three.",
    );
    expect(dirty).toHaveLength(3);
  });

  it.each([
    "pull",
    "frame",
  ] as const)("a frame and a rebase append (%s first) land the frame exactly once, as serialized", async (first) => {
    const draftId = await draftBehindLive();
    const frame = await writerFrame(draftId, appendParagraph("Extra."));
    const pull = () => fixture.view.draftPulls.flushLivePull(ALPHA_ID);
    try {
      const run =
        first === "pull"
          ? // The rebase holds the draft row between its append and COMMIT.
            await interleave(db, pull, "draft.append.beforeCommit", frame.send)
          : await interleave(db, frame.send, "draft.append.afterCommit", pull);
      const sent = (first === "pull" ? run.b : run.a) as Settled<{ admitted: boolean }>;
      expect(sent).toEqual({ ok: true, value: { admitted: true } });
      expect(first === "pull" ? run.a : run.b).toMatchObject({ ok: true });
      // The frame's append waited on the rebase's row lock, then judged against the result.
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
    if (!read || !row) throw new Error("the draft or its frame row is missing");
    // Rebase and writer are both tail appends; neither rewrites the checkpoint.
    expect(read.documentDraft.checkpointSeq).toBeLessThan(row.id);
    expect(read.tail.map((tail) => tail.id)).toContain(row.id);
  });

  /** A created document's fresh draft, with no contribution yet. */
  async function createdDocumentDraft(): Promise<{ draftId: string; branchId: string }> {
    const [branch] = await db
      .select({ id: schema.branches.id })
      .from(schema.branches)
      .where(eq(schema.branches.originWorkId, WORK_ID));
    if (!branch) throw new Error("the Work has no branch");
    await fixture.view.draftStore.ensureCreatedDocumentDraft({
      documentId: ALPHA_ID,
      branchId: branch.id as never,
    });
    return { draftId: await readDraftId(db, ALPHA_ID), branchId: branch.id };
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
        expect(run.a).toEqual({ ok: true, value: "stands" });
        expect(await writerRows(draftId)).toHaveLength(1);
      } else {
        // The retraction holds the rows and found nothing; the frame's append waits on them.
        const run = await interleave(db, retract, "retract.afterRecheck", frame.send);
        expect(run.bWaited).toBe(true);
        expect(run.a).toEqual({ ok: true, value: "retracted" });
        expect(run.b.ok && run.b.value.admitted).toBe(false);
        expect((await readDraftAt(db, draftId))?.documentDraft.status).toBe("closed");
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
    const remove = setTestHook("inverse.beforeCommitScope", async () => {
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
        expect(JSON.stringify(undone)).toContain("the document changed while reversing; try again");
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
        skips: [expect.objectContaining({ cause: "edited_since" })],
      });
    } finally {
      frames.remove();
    }
    expect(frames.commits()).toBe(4);
    expect(await fixture.view.draftMarkdown(draftId)).toBe("Alpha Delta.\n\nBlue.\n");
  });
});
