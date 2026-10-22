/**
 * The model's `move` and `delete` through the production-composed `write` tool (PR 3, D66,
 * D76, D77): each runs at the call and records a tree entry on the document's own stack, so
 * `undo`, `redo` and `revert` walk it with text, a reply's rollback reverses it, and the turn
 * card's Undo brings a deleted document back.
 */

import type { DocumentId } from "@meridian/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("the model's move and delete (postgres)", () => {});
} else {
  describe("the model's move and delete (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDb } = await import("@meridian/database");
    const { deleteDrizzleRows } = await import("../test-support/drizzle-reset.js");
    const { useComposedRuntimes } = await import("../test-support/composed-runtime.js");
    const { readRemovalRecords } = await import("../domains/context/tree/removal.js");

    const USER_ID = "00000000-0000-4000-8000-000000000d01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000d02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000d03";
    const WORK_ID = "00000000-0000-4000-8000-000000000d04";
    const THREAD = {
      threadId: "00000000-0000-4000-8000-000000000d05",
      turnId: "00000000-0000-4000-8000-000000000d06",
    };
    const CH1 = "00000000-0000-4000-8000-000000000d07";
    const CH2 = "00000000-0000-4000-8000-000000000d08";
    const OTHER_WORK_ID = "00000000-0000-4000-8000-000000000d09";
    const OTHER = {
      threadId: "00000000-0000-4000-8000-000000000d0a",
      turnId: "00000000-0000-4000-8000-000000000d0b",
    };
    const NEXT_TURN = "00000000-0000-4000-8000-000000000d0c";
    // Moves and deletes refresh the catalog after commit: real commits, no rollback suite.
    const db = createDb(DATABASE_URL, { max: 6 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "namespace-tools"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Namespace tools",
        slug: "namespace-tools",
      });
      await db.insert(schema.works).values([
        { projectId: PROJECT_ID, createdByUserId: USER_ID, name: "No Work", isNoWork: true },
        {
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Rewrite",
          handle: "w1",
        },
        {
          id: OTHER_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Polish",
          handle: "w2",
        },
      ]);
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.documents).values([
        { id: CH1, contextSourceId: SOURCE_ID, name: "ch1", extension: "", fileType: "markdown" },
        { id: CH2, contextSourceId: SOURCE_ID, name: "ch2", extension: "", fileType: "markdown" },
      ]);
      await db.insert(schema.threads).values({
        rootThreadId: THREAD.threadId,
        id: THREAD.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Renumbering",
        kind: "primary",
        status: "idle",
        aiWriteMode: "direct",
      });
      await db.insert(schema.threads).values({
        rootThreadId: OTHER.threadId,
        id: OTHER.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Polish",
        kind: "primary",
        status: "idle",
        aiWriteMode: "draft",
      });
      await db
        .insert(schema.turns)
        .values([
          turn(THREAD.turnId, THREAD.threadId, 1),
          turn(NEXT_TURN, THREAD.threadId, 2, THREAD.turnId),
          turn(OTHER.turnId, OTHER.threadId, 1),
        ]);
      await db.insert(schema.threadWorks).values([
        { threadId: THREAD.threadId, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true },
        { threadId: OTHER.threadId, workId: OTHER_WORK_ID, projectId: PROJECT_ID, isPrimary: true },
      ]);
    });

    function turn(id: string, threadId: string, position: number, parentTurnId?: string) {
      return {
        id,
        threadId,
        position,
        ...(parentTurnId ? { parentTurnId } : {}),
        role: "assistant" as const,
        origin: "assistant" as const,
        status: "complete" as const,
      };
    }

    async function start() {
      const runtime = await runtimes.compose();
      for (const [documentId, markdown] of [
        [CH1, "Chapter one."],
        [CH2, "Chapter two."],
      ] as const)
        await writeMarkdown(runtime.ports.documentSync, {
          documentId,
          markdown,
          origin: { type: "user", actorUserId: USER_ID },
          threadId: THREAD.threadId,
        });
      return runtimes.script(runtime, THREAD);
    }

    const text = (result: { output: unknown }) =>
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    const placement = async (id: string) =>
      (
        await db
          .select({ name: schema.documents.name, deletedAt: schema.documents.deletedAt })
          .from(schema.documents)
          .where(eq(schema.documents.id, id))
      )[0];
    const treeEntries = (id: string) =>
      db
        .select({ kind: schema.documentEdits.kind, tree: schema.documentEdits.treeChange })
        .from(schema.documentEdits)
        .where(
          and(eq(schema.documentEdits.documentId, id), isNotNull(schema.documentEdits.treeChange)),
        );

    it("moves at the call; undo by either path and redo walk it; A→B, B→C undoes back to A", async () => {
      const script = await start();
      const { call } = await script.begin();
      const moved = await call("write", {
        command: "move",
        from: { path: "ch1" },
        path: "ch1-old",
      });
      expect(moved.isError, text(moved)).toBeFalsy();
      expect(text(moved)).toContain("moved from manuscript://ch1");
      expect(await placement(CH1)).toMatchObject({ name: "ch1-old" });
      const again = await call("write", {
        command: "move",
        from: { path: "ch1-old" },
        path: "ch1-older",
      });
      expect(again.isError, text(again)).toBeFalsy();

      const listing = await call("read", { path: "ch1-older", format: "edits" });
      expect(text(listing)).toContain("moved from manuscript://ch1-old");

      // The old path no document holds names the document this chat moved away from it.
      const undone = await call("write", { command: "undo", path: "ch1-old" });
      expect(undone.isError, text(undone)).toBeFalsy();
      expect(await placement(CH1)).toMatchObject({ name: "ch1-old" });
      const undoneAgain = await call("write", { command: "undo", path: "ch1-old" });
      expect(undoneAgain.isError, text(undoneAgain)).toBeFalsy();
      expect(await placement(CH1)).toMatchObject({ name: "ch1" });

      const redone = await call("write", { command: "redo", path: "ch1", count: 2 });
      expect(redone.isError, text(redone)).toBeFalsy();
      expect(await placement(CH1)).toMatchObject({ name: "ch1-older" });
      expect((await treeEntries(CH1)).map((row) => row.kind).sort()).toEqual([
        "redo",
        "redo",
        "undo",
        "undo",
        "write",
        "write",
      ]);
    });

    it("deletes with the agent actor, and undo by the deleted path restores it", async () => {
      const script = await start();
      const { call } = await script.begin();
      const deleted = await call("write", { command: "delete", path: "ch2" });
      expect(deleted.isError, text(deleted)).toBeFalsy();
      expect((await placement(CH2))?.deletedAt).not.toBeNull();
      expect(
        (await readRemovalRecords(db, [CH2 as DocumentId])).get(CH2 as DocumentId),
      ).toMatchObject({
        reason: "deleted",
        actor: { kind: "agent", chatTitle: "Renumbering" },
      });

      const undone = await call("write", { command: "undo", path: "ch2" });
      expect(undone.isError, text(undone)).toBeFalsy();
      expect((await placement(CH2))?.deletedAt).toBeNull();
      expect(text(await call("read", { path: "ch2" }))).toContain("Chapter two.");
    });

    it("rolls a reply's move and delete back, reports the one it can't, and keeps another Work's draft", async () => {
      const script = await start();
      // w2's draft-mode chat drafts a change to ch2: a live delete leaves it alone (D79).
      await runtimes.script(script.runtime, OTHER).reply(async (call) => {
        await call("write", { command: "replace", path: "ch2", find: "two", content: "2" });
      });
      await script.runtime.ports.documentSync.draftEffects.flush();
      const { call, responseId } = await script.begin();
      expect(
        (await call("write", { command: "move", from: { path: "ch1" }, path: "ch9" })).isError,
      ).toBeFalsy();
      const deleted = await call("write", { command: "delete", path: "ch2" });
      expect(text(deleted)).toContain("w2 still has changes to it; applying them brings it back.");
      // The writer makes a new ch2 before the reply fails: ch2's restore finds it taken.
      await db.insert(schema.documents).values({
        contextSourceId: SOURCE_ID,
        name: "ch2",
        extension: "",
        fileType: "markdown",
      });

      const rolledBack = await script.runtime.ports.documentSync.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        THREAD as never,
      );
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
      expect((await placement(CH2))?.deletedAt).not.toBeNull();
      expect(rolledBack.skipped).toEqual([
        expect.objectContaining({ documentId: CH2, reason: "its location is taken" }),
      ]);
      const drafts = await db
        .select({ status: schema.documentDrafts.status })
        .from(schema.documentDrafts)
        .where(
          and(
            eq(schema.documentDrafts.documentId, CH2),
            eq(schema.documentDrafts.kind, "work_draft"),
          ),
        );
      expect(drafts).toEqual([{ status: "active" }]);
    });

    it("refuses an undo the writer's later removal superseded, and names a document now at the path", async () => {
      const script = await start();
      const { call } = await script.begin();
      expect((await call("write", { command: "delete", path: "ch2" })).isError).toBeFalsy();
      // A different removal is current: the writer restored it and deleted it again.
      await db
        .update(schema.documents)
        .set({
          deletedAt: new Date(Date.now() + 60_000),
          deletedByThreadId: null,
          locationVersion: sql`${schema.documents.locationVersion} + 2`,
        })
        .where(eq(schema.documents.id, CH2));
      const superseded = await call("write", { command: "undo", path: "ch2" });
      expect(superseded.isError).toBe(true);
      expect(text(superseded)).toContain("cant_undo_changed");

      await db.insert(schema.documents).values({
        contextSourceId: SOURCE_ID,
        name: "ch2",
        extension: "",
        fileType: "markdown",
      });
      const displaced = await call("write", { command: "undo", path: "ch2" });
      expect(text(displaced)).toContain(
        "A different document is at manuscript://ch2 now. Ask the user to undo the deletion from your reply's card.",
      );
    });

    it("walks text and tree edits on one stack across turns, and a card Undo dirties the move's turn", async () => {
      const script = await start();
      const first = await script.begin();
      expect(
        (await first.call("write", { command: "replace", path: "ch1", find: "one", content: "1" }))
          .isError,
      ).toBeFalsy();
      await first.save();
      expect(
        (await first.call("write", { command: "move", from: { path: "ch1" }, path: "intro" }))
          .isError,
      ).toBeFalsy();
      const later = await runtimes.script(script.runtime, { ...THREAD, turnId: NEXT_TURN }).begin();
      expect(
        (
          await later.call("write", {
            command: "replace",
            path: "intro",
            find: "1",
            content: "One",
          })
        ).isError,
      ).toBeFalsy();
      await later.save();
      for (const [name, body] of [
        ["intro", "Chapter 1."],
        ["ch1", "Chapter 1."],
        ["ch1", "Chapter one."],
      ] as const) {
        const undone = await later.call("write", {
          command: "undo",
          path: name === "intro" ? "intro" : "ch1",
        });
        expect(undone.isError, text(undone)).toBeFalsy();
        expect(await placement(CH1)).toMatchObject({ name });
        expect(await script.text(name)).toContain(body);
      }
      const redone = await later.call("write", { command: "redo", path: "ch1", count: 3 });
      expect(redone.isError, text(redone)).toBeFalsy();
      expect(await placement(CH1)).toMatchObject({ name: "intro" });
      expect(await script.text("intro")).toContain("Chapter One.");

      // The writer's card Undo of the first turn moves it back; its human row has no thread,
      // and still dirties that turn's trail.
      await db.delete(schema.changeTrailDirtyLog);
      const reversed = await script.runtime.ports.documentSync.reverseThreadContext({
        threadId: THREAD.threadId as never,
        userId: USER_ID as never,
        direction: "undo",
        turnId: THREAD.turnId as never,
      });
      expect(reversed.status, JSON.stringify(reversed)).toMatch(/reversed|partial/);
      expect(await placement(CH1)).toMatchObject({ name: "ch1" });
      const dirty = await db
        .select({ turnId: schema.changeTrailDirtyLog.turnId })
        .from(schema.changeTrailDirtyLog)
        .where(eq(schema.changeTrailDirtyLog.threadId, THREAD.threadId));
      expect(dirty.map((row) => row.turnId)).toContain(THREAD.turnId);
    });

    it("refuses a draft-mode move between a drafted document and a live one (D45)", async () => {
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.threads.id, THREAD.threadId));
      const script = await start();
      const { call } = await script.begin();
      const mixed = await call("write", {
        command: "move",
        from: { path: "ch1" },
        path: "scratch://ch1",
      });
      expect(text(mixed)).toContain(
        "This chat is in draft mode, so this move would be half drafted and half live.",
      );
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
    });
  });
}
