/**
 * The model's `move` and `delete` through the production-composed `write` tool (PR 3, D66,
 * D76, D77): each runs at the call and records a tree entry on the document's own stack, so
 * `undo`, `redo` and `revert` walk it with text, a reply's rollback reverses it, and the turn
 * card's Undo brings a deleted document back. In a draft-mode chat they are facts in the
 * Work's branch and live is untouched (D26).
 */

import { randomUUID } from "node:crypto";
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
    const { createTreeReader } = await import("../domains/context/tree/tree-view.js");
    const {
      handleApplyClickRequest,
      handleDiscardWorkDraftRequest,
      handleWorkBranchListRequest,
      selectBranchRouteServices,
    } = await import("./branch-review-route.js");

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
        )
        .orderBy(sql`(${schema.documentEdits.treeChange}->>'seq')::bigint`);

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

    it("moves onto an occupied model path at the free name and reports where it landed", async () => {
      const script = await start();
      const { call } = await script.begin();
      const moved = await call("write", {
        command: "move",
        from: { path: "ch1" },
        path: "ch2",
      });
      expect(moved.isError, text(moved)).toBeFalsy();
      expect(text(moved)).toContain("manuscript://ch2 (2)");
      expect(await placement(CH1)).toMatchObject({ name: "ch2 (2)" });
      expect(await placement(CH2)).toMatchObject({ name: "ch2" });
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

      // The writer takes the path; the model moves that document aside as the refusal says and
      // undoes by the path again: the deletion is undone, not the newer move of the blocker.
      await db.insert(schema.documents).values({
        contextSourceId: SOURCE_ID,
        name: "ch2",
        extension: "",
        fileType: "markdown",
      });
      expect(text(await call("write", { command: "undo", path: "ch2" }))).toContain(
        "is taken by a different document",
      );
      expect(
        (await call("write", { command: "move", from: { path: "ch2" }, path: "ch2-new" })).isError,
      ).toBeFalsy();
      const undone = await call("write", { command: "undo", path: "ch2" });
      expect(undone.isError, text(undone)).toBeFalsy();
      expect((await placement(CH2))?.deletedAt).toBeNull();
      expect(text(await call("read", { path: "ch2" }))).toContain("Chapter two.");
    });

    it("rolls a reply's move and delete back at a free name and keeps another Work's draft", async () => {
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
      expect(text(deleted)).toContain(
        `Work "Polish" still has changes to it; applying them brings it back.`,
      );
      // The writer makes a new ch2 before the reply fails: the restored document lands beside it.
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
      expect(await placement(CH2)).toMatchObject({ name: "ch2 (2)", deletedAt: null });
      expect(rolledBack.skipped).toEqual([]);
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
        "manuscript://ch2 is taken by a different document. Use `ls` to check what is there; move or rename it, then `undo` again.",
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

    const branchOf = async (workId: string) => {
      const [row] = await db
        .select({ id: schema.branches.id })
        .from(schema.branches)
        .where(and(eq(schema.branches.originWorkId, workId), eq(schema.branches.status, "active")));
      if (!row) throw new Error(`Work ${workId} has no active branch`);
      return row.id as never;
    };
    const branchRow = async (documentId: string) =>
      (
        await db
          .select()
          .from(schema.branchTreeChanges)
          .where(eq(schema.branchTreeChanges.nodeId, documentId))
      )[0];

    it("a draft-mode move and delete change only the Work's branch; undo and redo walk them", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      await drafting.reply(async (edit) => {
        await edit("write", { command: "replace", path: "ch2", find: "two", content: "2" });
      });
      const { call } = await drafting.begin();
      const moved = await call("write", {
        command: "move",
        from: { path: "ch1" },
        path: "part1/ch1-old",
      });
      expect(moved.isError, text(moved)).toBeFalsy();
      expect(text(moved)).toContain(
        "not applied yet: moved only in this chat's draft; live still has it at manuscript://ch1 until the user applies it.",
      );
      expect(text(moved)).toContain("version: draft (w2)");
      // Live is untouched; the branch has it at the new path, in a folder only it sees.
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
      expect(text(await call("read", { path: "part1/ch1-old" }))).toContain("Chapter one.");
      expect((await call("read", { path: "ch1" })).isError).toBe(true);
      expect(await script.text("ch1")).toContain("Chapter one.");
      expect((await (await script.begin()).call("read", { path: "part1/ch1-old" })).isError).toBe(
        true,
      );
      const tree = createTreeReader(db);
      const branchId = await branchOf(OTHER_WORK_ID);
      const [node] = await tree.treeState(branchId, [], [CH1 as DocumentId]);
      expect(node).toMatchObject({
        pending: true,
        branch: { state: "moving", moved: true },
        target: { path: "part1/ch1-old", uri: "manuscript://part1/ch1-old" },
        from: { path: "ch1", uri: "manuscript://ch1" },
      });

      // The drafted delete hides the draft's text change too; its undo loses nothing.
      const deleted = await call("write", { command: "delete", path: "ch2" });
      expect(deleted.isError, text(deleted)).toBeFalsy();
      expect(text(deleted)).toContain(
        "not applied yet: deleted only in this chat's draft; it stays live until the user applies it.",
      );
      expect((await placement(CH2))?.deletedAt).toBeNull();
      expect((await call("read", { path: "ch2" })).isError).toBe(true);
      expect(await branchRow(CH2)).toMatchObject({ deleted: true, moved: false });

      // Undo by the path the model deleted it from brings it back in the branch only.
      const restored = await call("write", { command: "undo", path: "ch2" });
      expect(restored.isError, text(restored)).toBeFalsy();
      expect(text(await call("read", { path: "ch2" }))).toContain("Chapter 2.");
      expect(await branchRow(CH2)).toBeUndefined();
      const redone = await call("write", { command: "redo", path: "ch2" });
      expect(redone.isError, text(redone)).toBeFalsy();
      expect((await call("read", { path: "ch2" })).isError).toBe(true);

      // Undo by the old path of the move: the document follows live again.
      const back = await call("write", { command: "undo", path: "ch1" });
      expect(back.isError, text(back)).toBeFalsy();
      expect(text(await call("read", { path: "ch1" }))).toContain("Chapter one.");
      expect(await branchRow(CH1)).toBeUndefined();
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
      const kinds = (await treeEntries(CH1)).map((row) => row.tree?.destination.kind);
      expect(kinds).toEqual(["draft", "draft"]);

      // The writer's card reverses the drafted move and delete with the draft text, in the
      // branch only, and redoes them.
      expect((await call("write", { command: "redo", path: "ch1" })).isError).toBeFalsy();
      const card = (direction: "undo" | "redo") =>
        script.runtime.ports.documentSync.reverseThreadContext({
          threadId: OTHER.threadId as never,
          userId: USER_ID as never,
          direction,
          turnId: OTHER.turnId as never,
        });
      const undone = await card("undo");
      expect(undone.status, JSON.stringify(undone)).toBe("reversed");
      // Reported where it landed: the Work's proposal, though the move has no text draft.
      expect(undone.documents.map((row) => row.destination)).toEqual([
        { kind: "draft", branchId },
        { kind: "draft", branchId },
      ]);
      expect(await branchRow(CH1)).toBeUndefined();
      expect(await branchRow(CH2)).toBeUndefined();
      expect(text(await call("read", { path: "ch2" }))).toContain("Chapter two.");
      const redoneByCard = await card("redo");
      expect(redoneByCard.status, JSON.stringify(redoneByCard)).toBe("reversed");
      expect(await branchRow(CH1)).toMatchObject({ moved: true, movedName: "ch1-old" });
      expect(await branchRow(CH2)).toMatchObject({ deleted: true });
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
      expect((await placement(CH2))?.deletedAt).toBeNull();
    });

    it("records allocated drafted inverse facts so undo and redo stay reversible", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      const { call } = await drafting.begin();
      expect(
        (await call("write", { command: "move", from: { path: "ch1" }, path: "B" })).isError,
      ).toBeFalsy();
      expect(
        (await call("write", { command: "move", from: { path: "ch2" }, path: "ch1" })).isError,
      ).toBeFalsy();

      expect((await call("write", { command: "undo", path: "B" })).isError).toBeFalsy();
      expect(await branchRow(CH1)).toMatchObject({ moved: true, movedName: "ch1 (2)" });
      expect((await call("write", { command: "redo", path: "ch1 (2)" })).isError).toBeFalsy();
      expect(await branchRow(CH1)).toMatchObject({ moved: true, movedName: "B" });

      expect(
        (await call("write", { command: "move", from: { path: "B" }, path: "Y" })).isError,
      ).toBeFalsy();
      expect(
        (await call("write", { command: "move", from: { path: "ch1" }, path: "B" })).isError,
      ).toBeFalsy();
      expect((await call("write", { command: "undo", path: "Y" })).isError).toBeFalsy();
      expect(await branchRow(CH1)).toMatchObject({ moved: true, movedName: "B (2)" });
      expect((await call("write", { command: "redo", path: "B (2)" })).isError).toBeFalsy();
      expect(await branchRow(CH1)).toMatchObject({ moved: true, movedName: "Y" });
    });

    it("a drafted delete of the branch's own creation undoes; a live delete keeps a Work's drafted move", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      await drafting.reply(async (create) => {
        await create("write", { command: "create", path: "notes" });
      });
      const { call } = await drafting.begin();
      const deletedNew = await call("write", { command: "delete", path: "notes" });
      expect(deletedNew.isError, text(deletedNew)).toBeFalsy();
      expect((await call("read", { path: "notes" })).isError).toBe(true);
      const undone = await call("write", { command: "undo", path: "notes" });
      expect(undone.isError, text(undone)).toBeFalsy();
      expect((await call("read", { path: "notes" })).isError).toBeFalsy();

      expect(
        (await call("write", { command: "move", from: { path: "ch2" }, path: "ch2-old" })).isError,
      ).toBeFalsy();
      // The model in the direct chat deletes ch2 live: w2's move stays, and is a restore now.
      const live = await (await script.begin()).call("write", { command: "delete", path: "ch2" });
      expect(live.isError, text(live)).toBeFalsy();
      expect((await placement(CH2))?.deletedAt).not.toBeNull();
      expect(await branchRow(CH2)).toMatchObject({ moved: true, movedName: "ch2-old" });
      const [node] = await createTreeReader(db).treeState(
        await branchOf(OTHER_WORK_ID),
        [],
        [CH2 as DocumentId],
      );
      expect(node).toMatchObject({ pending: true, deleted: true, target: { path: "ch2-old" } });
      expect(text(await call("read", { path: "ch2-old" }))).toContain("Chapter two.");

      // A failed reply's rollback writes the branch's facts back.
      const failing = await drafting.begin();
      expect(
        (await failing.call("write", { command: "move", from: { path: "ch1" }, path: "ch1-x" }))
          .isError,
      ).toBeFalsy();
      await script.runtime.ports.documentSync.finalizeResponseRollback(
        { providerResponseId: failing.responseId, editScopeId: failing.responseId },
        OTHER as never,
      );
      expect(await branchRow(CH1)).toBeUndefined();
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
    });

    /** The Work's review routes over the composed app, as the writer's clicks reach them. */
    function review(script: Awaited<ReturnType<typeof start>>) {
      const routes = selectBranchRouteServices(script.runtime.app);
      const scope = { userId: USER_ID, projectId: PROJECT_ID, workId: OTHER_WORK_ID } as never;
      const item = async (documentId: string) =>
        (await handleWorkBranchListRequest(routes, scope)).items.find(
          (row) => row.documentId === documentId,
        );
      return {
        item,
        apply: async (documentId: string, extra: Record<string, unknown> = {}) =>
          handleApplyClickRequest(routes, {
            ...(scope as object),
            documentId: documentId as never,
            request: {
              commandId: randomUUID(),
              groupIds: [],
              baseViewDelta: [],
              tree: { revision: (await item(documentId))?.tree?.revision ?? null },
              ...extra,
            },
          } as never),
        discard: async (documentId: string) => {
          const row = await item(documentId);
          return handleDiscardWorkDraftRequest(routes, {
            ...(scope as object),
            documentId: documentId as never,
            request: { branchId: row?.branchId, itemKey: row?.itemKey, commandId: randomUUID() },
          } as never);
        },
      };
    }
    const settlements = async (id: string) =>
      (await treeEntries(id)).flatMap((row) =>
        row.tree?.op === "settle" ? [row.tree.settles.as] : [],
      );

    it("Apply orders a move chain and swap, then reports a free name when a later arrival took its target", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      const draft = (args: Record<string, unknown>) =>
        drafting.reply(async (edit) => {
          await edit("write", args);
        });
      const writer = review(script);

      // One row owns its whole dependency chain under the branch lock.
      await draft({ command: "move", from: { path: "ch2" }, path: "ch3" });
      await draft({ command: "move", from: { path: "ch1" }, path: "ch2" });
      expect(await writer.apply(CH1)).toMatchObject({
        status: "applied",
        applied: [
          { itemKey: expect.stringContaining(CH2) },
          { itemKey: expect.stringContaining(CH1) },
        ],
      });
      expect(await placement(CH1)).toMatchObject({ name: "ch2" });
      expect(await placement(CH2)).toMatchObject({ name: "ch3" });
      expect(await settlements(CH1)).toEqual(["applied"]);

      // Draft through a temporary name to express ch2↔ch3, then Apply either row.
      await draft({ command: "move", from: { path: "ch2" }, path: "temporary" });
      await draft({ command: "move", from: { path: "ch3" }, path: "ch2" });
      await draft({ command: "move", from: { path: "temporary" }, path: "ch3" });
      // Apply the newer occupant's row; cycle order must not decide who keeps an exact name.
      expect(await writer.apply(CH2)).toMatchObject({
        status: "applied",
        applied: expect.arrayContaining([
          expect.objectContaining({ itemKey: expect.stringContaining(CH1) }),
          expect.objectContaining({ itemKey: expect.stringContaining(CH2) }),
        ]),
      });
      expect(await placement(CH1)).toMatchObject({ name: "ch3" });
      expect(await placement(CH2)).toMatchObject({ name: "ch2" });

      // A later live arrival wins the requested leaf; Apply lands beside it and says where.
      await draft({ command: "move", from: { path: "ch3" }, path: "final" });
      await script.reply(async (edit) => {
        await edit("write", { command: "create", path: "final", content: "Occupied." });
      });
      expect(await writer.apply(CH1)).toMatchObject({
        status: "applied",
        applied: [
          {
            itemKey: expect.stringContaining(CH1),
            renamed: {
              code: "renamed",
              wanted: "manuscript://final",
              path: "manuscript://final (2)",
            },
          },
        ],
      });
      expect(await placement(CH1)).toMatchObject({ name: "final (2)" });
      const { call } = await drafting.begin();
      expect(text(await call("write", { command: "undo", path: "final (2)" }))).toContain(
        "applied",
      );

      // A frozen click the model changed since answers changed; a delete after a live edit lands.
      await draft({ command: "move", from: { path: "final (2)" }, path: "part1/ch3" });
      const revision = (await writer.item(CH1))?.tree?.revision ?? null;
      await draft({ command: "delete", path: "part1/ch3" });
      expect(await writer.apply(CH1, { tree: { revision } })).toMatchObject({ status: "changed" });
      await script.reply(async (edit) => {
        await edit("write", {
          command: "replace",
          path: "final (2)",
          find: "one",
          content: "1",
        });
      });
      expect(await writer.apply(CH1)).toMatchObject({ status: "applied" });
      // Moved then deleted: only the delete applies, where live has it; its hidden folder goes.
      expect(await placement(CH1)).toMatchObject({ name: "final (2)" });
      expect((await placement(CH1))?.deletedAt).not.toBeNull();
      const part1 = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .where(and(eq(schema.folders.name, "part1"), sql`${schema.folders.deletedAt} IS NULL`));
      expect(part1).toEqual([]);
    });

    it("Apply restores a moved document at the Work's place; Discard drops a move and keeps its text", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      const draft = (args: Record<string, unknown>) =>
        drafting.reply(async (edit) => {
          await edit("write", args);
        });
      const writer = review(script);

      // Deleted live, another document at its old path: restored where the Work moved it.
      await draft({ command: "move", from: { path: "ch1" }, path: "part1/ch1-moved" });
      await script.reply(async (edit) => {
        await edit("write", { command: "delete", path: "ch1" });
        await edit("write", { command: "create", path: "ch1", content: "New." });
      });
      expect(await writer.apply(CH1)).toMatchObject({ status: "needs_restore" });
      expect(await writer.apply(CH1, { restore: true })).toMatchObject({
        status: "applied",
        restored: true,
      });
      expect(await placement(CH1)).toMatchObject({ name: "ch1-moved", deletedAt: null });

      // A drafted delete of a document live deleted too settles, with no restore.
      await draft({ command: "delete", path: "ch2" });
      const revision = (await writer.item(CH2))?.tree?.revision ?? null;
      await script.reply(async (edit) => {
        await edit("write", { command: "delete", path: "ch2" });
      });
      expect(await writer.apply(CH2, { tree: { revision } })).toMatchObject({ status: "applied" });
      expect((await placement(CH2))?.deletedAt).not.toBeNull();
      expect(await settlements(CH2)).toEqual(["applied"]);

      // Discard of a move keeps the text change; the model's undo then says discarded.
      await draft({ command: "replace", path: "part1/ch1-moved", find: "one", content: "ONE" });
      await draft({ command: "move", from: { path: "part1/ch1-moved" }, path: "ch1-final" });
      expect(await writer.discard(CH1)).toMatchObject({ body: { status: "discarded" } });
      expect(await writer.item(CH1)).toMatchObject({ hasDraft: true, tree: null });
      expect(await drafting.text("part1/ch1-moved")).toContain("Chapter ONE.");
      const { call } = await drafting.begin();
      expect(text(await call("write", { command: "undo", path: "part1/ch1-moved" }))).toContain(
        "discarded",
      );
      expect(await settlements(CH1)).toEqual(["applied", "discarded"]);

      // Apply names the move in effect applied, and one undone before it discarded.
      await draft({ command: "move", from: { path: "part1/ch1-moved" }, path: "ch1-b" });
      await drafting.reply(async (edit) => {
        await edit("write", { command: "undo", path: "ch1-b" });
      });
      await draft({ command: "move", from: { path: "part1/ch1-moved" }, path: "ch1-c" });
      expect(await writer.apply(CH1)).toMatchObject({ status: "applied" });
      expect(await settlements(CH1)).toEqual(["applied", "discarded", "applied", "discarded"]);
    });
  });
}
