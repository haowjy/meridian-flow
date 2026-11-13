/**
 * The model's `move` and `delete` through the production-composed `write` tool (PR 3): each runs at the call and records a tree entry on the document's own stack, so
 * `undo`, `redo` and `revert` walk it with text, a reply's rollback reverses it, and the turn
 * card's Undo brings a deleted document back. In a draft-mode chat they are facts in the
 * Work's branch and live is untouched.
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";
import { treeSeeder } from "../test-support/tree-seed.js";

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
    const { createTreeReader } = await import("../domains/context/tree/tree-view.js");
    const {
      handleApplyClickRequest,
      handleDiscardWorkDraftRequest,
      handleOwnerDraftListRequest,
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
    const SCRATCH_SOURCE = "00000000-0000-4000-8000-000000000d0d";
    const SCRATCH_NOTE = "00000000-0000-4000-8000-000000000d0e";
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
      });
      await db.insert(schema.contextSources).values({
        id: SCRATCH_SOURCE,
        workId: OTHER_WORK_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      const seeds = treeSeeder(db);
      await seeds.document(SOURCE_ID, "ch1", { id: CH1 });
      await seeds.document(SOURCE_ID, "ch2", { id: CH2 });
      await seeds.document(SCRATCH_SOURCE, "sect-notes", { id: SCRATCH_NOTE });
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
        [SCRATCH_NOTE, "Sect notes."],
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
          .select({
            name: schema.treeNodes.name,
            sourceId: schema.treeNodes.contextSourceId,
            deletedAt: schema.treeNodes.trashedAt,
          })
          .from(schema.treeNodes)
          .where(eq(schema.treeNodes.id, id))
      )[0];
    const branchOf = async (workId: string) => {
      const [row] = await db
        .select({ id: schema.branches.id })
        .from(schema.branches)
        .where(and(eq(schema.branches.originWorkId, workId), eq(schema.branches.status, "active")));
      if (!row) throw new Error(`Work ${workId} has no active branch`);
      return row.id as never;
    };
    const treeEntries = (id: string) =>
      db
        .select({ kind: schema.documentEdits.kind, tree: schema.documentEdits.treeChange })
        .from(schema.documentEdits)
        .where(
          and(eq(schema.documentEdits.documentId, id), isNotNull(schema.documentEdits.treeChange)),
        )
        .orderBy(sql`(${schema.documentEdits.treeChange}->>'seq')::bigint`);

    it("refuses a move or delete of a path that names a folder beside the document it renders as", async () => {
      await treeSeeder(db).folder(SOURCE_ID, "ch1.md");
      const script = await start();
      const { call } = await script.begin();
      for (const path of ["ch1.md", "ch1.md/", "/ch1.md/", "manuscript://ch1.md"]) {
        expect(text(await call("write", { command: "delete", path }))).toContain("folder");
        expect(
          text(await call("write", { command: "move", from: { path }, path: "renamed" })),
        ).toContain("folder");
      }
      expect((await placement(CH1))?.deletedAt).toBeNull();
      expect((await placement(CH1))?.name).toBe("ch1");
    });

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

    function review(script: Awaited<ReturnType<typeof start>>) {
      const routes = selectBranchRouteServices(script.runtime.app);
      const scope = { userId: USER_ID, projectId: PROJECT_ID } as const;
      const item = async (documentId: string) =>
        (
          await handleOwnerDraftListRequest(routes, {
            ...scope,
            owner: `work:${OTHER_WORK_ID}`,
          } as never)
        ).items.find((row) => row.documentId === documentId);
      return {
        item,
        apply: async (documentId: string, extra: Record<string, unknown> = {}) =>
          handleApplyClickRequest(routes, {
            ...scope,
            branchId: await branchOf(OTHER_WORK_ID),
            documentId: documentId as never,
            request: {
              commandId: randomUUID(),
              groupIds: [],
              baseViewDelta: [],
              tree: { revision: (await item(documentId))?.tree?.revision ?? null },
              ...extra,
            },
          } as never),
        discard: async (documentId: string, ends: Record<string, unknown> = { ends: "tree" }) => {
          const row = await item(documentId);
          return handleDiscardWorkDraftRequest(routes, {
            ...scope,
            branchId: row?.branchId,
            documentId: documentId as never,
            request: {
              branchId: row?.branchId,
              itemKey: row?.itemKey,
              commandId: randomUUID(),
              ...ends,
            },
          } as never);
        },
      };
    }
    const settlements = async (id: string) =>
      (await treeEntries(id)).flatMap((row) =>
        row.tree?.op === "settle" ? [row.tree.settles.as] : [],
      );

    it("drafts a Scratch move into the manuscript and applies it", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      let result = "";
      await drafting.reply(async (edit) => {
        result = await edit("write", {
          command: "move",
          from: { path: "scratch://@w2/sect-notes" },
          path: "manuscript://sect-notes",
        });
      });

      expect(result).toContain("not applied yet");
      expect(await placement(SCRATCH_NOTE)).toMatchObject({
        name: "sect-notes",
        sourceId: SCRATCH_SOURCE,
        deletedAt: null,
      });
      expect(await review(script).item(SCRATCH_NOTE)).toMatchObject({
        contextLocation: { scheme: "manuscript", path: "/sect-notes" },
      });

      const undoTurn = await drafting.begin();
      const undone = await undoTurn.call("write", {
        command: "undo",
        path: "manuscript://sect-notes",
      });
      expect(undone.isError, text(undone)).toBeFalsy();
      await undoTurn.save();
      expect(await review(script).item(SCRATCH_NOTE)).toBeUndefined();

      const redoTurn = await drafting.begin();
      const redone = await redoTurn.call("write", {
        command: "redo",
        path: "scratch://@w2/sect-notes",
      });
      expect(redone.isError, text(redone)).toBeFalsy();
      await redoTurn.save();

      expect(await review(script).apply(SCRATCH_NOTE)).toMatchObject({ status: "applied" });
      expect(await placement(SCRATCH_NOTE)).toMatchObject({
        name: "sect-notes",
        sourceId: SOURCE_ID,
        deletedAt: null,
      });
    });

    it("a whole-item Discard of a moved, edited document closes its text draft too", async () => {
      const script = await start();
      const drafting = runtimes.script(script.runtime, OTHER);
      const writer = review(script);
      await drafting.reply(async (edit) => {
        await edit("write", { command: "replace", path: "ch1", find: "one", content: "ONE" });
        await edit("write", { command: "move", from: { path: "ch1" }, path: "part1/ch1-moved" });
      });
      const seen = await writer.item(CH1);
      expect(seen).toMatchObject({ hasDraft: true, tree: { movedFrom: { path: "/ch1" } } });
      const textDrafts = () =>
        db
          .select({ status: schema.documentDrafts.status })
          .from(schema.documentDrafts)
          .where(
            and(
              eq(schema.documentDrafts.documentId, CH1),
              eq(schema.documentDrafts.kind, "work_draft"),
            ),
          );

      // Decided on a draft that moved on since: refused, and nothing ends.
      expect(
        await writer.discard(CH1, { ends: "item", draftSeenAt: "2000-01-01T00:00:00.000Z" }),
      ).toMatchObject({ body: { status: "draft_changed" } });
      expect(await writer.item(CH1)).toMatchObject({
        hasDraft: true,
        tree: { revision: seen?.tree?.revision },
      });

      expect(
        await writer.discard(CH1, { ends: "item", draftSeenAt: seen?.updatedAt }),
      ).toMatchObject({
        body: { status: "discarded", itemClosed: true, itemDisposition: "discarded" },
      });
      expect(await writer.item(CH1)).toBeUndefined();
      expect(await textDrafts()).toEqual([{ status: "closed" }]);
      expect(await placement(CH1)).toMatchObject({ name: "ch1", deletedAt: null });
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
      expect(await writer.discard(CH1)).toMatchObject({
        body: { status: "discarded", itemClosed: false },
      });
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
