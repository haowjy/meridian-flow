/**
 * The AI's tree commands (`move`, `delete`, `restore`, folders) through the production-composed
 * `write` tool: a path resolves through the names the model was shown, each call is its own
 * command, and the receipt it keeps is what `undo` names, live, drafted, applied or discarded.
 * In a draft-mode chat they are records of the Work's branch and live is untouched.
 */

import { randomUUID } from "node:crypto";
import { type ToolContentPart, toolContentText } from "@meridian/contracts/threads";
import { LIVE, listRecords, type TreeWriter } from "@meridian/project-tree";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleJournal } from "../domains/collab/adapters/drizzle-journal.js";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import { discardedTree } from "../domains/context/tree/trash-entries.js";
import { runWorkLifecycleCommand } from "../domains/projects/index.js";
import { createDrizzleThreadLock } from "../domains/runtime/adapters/drizzle-thread-lock.js";
import { setTestHook } from "../shared/test-hooks.js";
import { race } from "../test-support/lock-interleave.js";
import { treeListOfSource, treeSeeder } from "../test-support/tree-seed.js";
import { reverseTurnCard } from "./work-receipt-reversal.js";

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
        isPersonal: true,
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
        projectId: PROJECT_ID,
        name: "User Files",
        slug: "user",
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
      await seeds.folder(SOURCE_ID, "part1");
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

    let composed: Awaited<ReturnType<typeof runtimes.compose>>;
    async function start() {
      const runtime = await runtimes.compose();
      composed = runtime;
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

    const text = (result: { content: ToolContentPart[] }) => toolContentText(result.content);
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
    it("a path that names a folder beside the document it renders as reaches the folder", async () => {
      await treeSeeder(db).folder(SOURCE_ID, "ch1.md");
      const script = await start();
      const { call } = await script.begin();
      const deleted = await call("write", { command: "delete", path: "ch1.md" });
      expect(deleted.isError, text(deleted)).toBeFalsy();
      expect(text(deleted)).toContain("deleted: 0 inside");
      expect((await placement(CH1))?.deletedAt).toBeNull();
      expect((await placement(CH1))?.name).toBe("ch1");
    });

    it("moves at the call, each move its own command: A→B, B→C", async () => {
      const script = await start();
      const { call } = await script.begin();
      const moved = await call("write", {
        command: "move",
        from: { path: "ch1" },
        path: "ch1-old",
      });
      expect(moved.isError, text(moved)).toBeFalsy();
      expect(text(moved)).toMatch(/^status: success; write: e\d+; version: live$/);
      expect(await placement(CH1)).toMatchObject({ name: "ch1-old" });
      const again = await call("write", {
        command: "move",
        from: { path: "ch1-old" },
        path: "ch1-older",
      });
      expect(again.isError, text(again)).toBeFalsy();
      expect(await placement(CH1)).toMatchObject({ name: "ch1-older" });
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

      // A drafted delete of a document live deleted too is no change to review: nothing to apply.
      await draft({ command: "delete", path: "ch2" });
      expect(await writer.item(CH2)).toMatchObject({ tree: { revision: expect.any(String) } });
      await script.reply(async (edit) => {
        await edit("write", { command: "delete", path: "ch2" });
      });
      expect(await writer.item(CH2)).toBeUndefined();
      expect((await placement(CH2))?.deletedAt).not.toBeNull();

      // Discard of a move keeps the text change;
      await draft({ command: "replace", path: "part1/ch1-moved", find: "one", content: "ONE" });
      await draft({ command: "move", from: { path: "part1/ch1-moved" }, path: "ch1-final" });
      expect(await writer.discard(CH1)).toMatchObject({
        body: { status: "discarded", itemClosed: false },
      });
      expect(await writer.item(CH1)).toMatchObject({ hasDraft: true, tree: null });
      expect(await drafting.text("part1/ch1-moved")).toContain("Chapter ONE.");

      await draft({ command: "move", from: { path: "part1/ch1-moved" }, path: "ch1-c" });
      expect(await writer.apply(CH1)).toMatchObject({ status: "applied" });
      expect(await placement(CH1)).toMatchObject({ name: "ch1-c", deletedAt: null });
    });

    const store = () => createDrizzleTreeListStore({ db, journal: createDrizzleJournal(db) });
    /** The writer's own change to the project's list, as their browser's record would be admitted. */
    const asWriter = async (make: (writer: TreeWriter) => void) =>
      store().submit({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        make: ([{ writer }]) => make(writer),
      });
    const WRITER = `user:${USER_ID}`;
    const placementsNamed = async (name: string) =>
      db
        .select({ id: schema.treeNodes.id, deletedAt: schema.treeNodes.trashedAt })
        .from(schema.treeNodes)
        .where(eq(schema.treeNodes.name, name));
    const drafting = (script: Awaited<ReturnType<typeof start>>) =>
      runtimes.script(script.runtime, OTHER);

    it("a stale path reaches the node the model meant, and the result says what the writer did", async () => {
      const script = await start();
      const { call } = await script.begin();
      await call("ls", { path: "manuscript://" });
      await asWriter((writer) => writer.rename(LIVE, WRITER, CH1, "The Fall"));
      const moved = await call("write", {
        command: "move",
        from: { path: "ch1" },
        path: "part1/ch1",
      });
      expect(moved.isError, text(moved)).toBeFalsy();
      expect(text(moved)).toMatch(
        /^status: success; path: manuscript:\/\/part1\/The Fall; write: e\d+; version: live\n\nconcurrent tree changes by the user:\n {2}renamed: manuscript:\/\/ch1 → The Fall$/,
      );
      expect(await placement(CH1)).toMatchObject({ name: "The Fall" });
    });

    it("a name given to another document since is refused as path_changed, and nothing is touched", async () => {
      const script = await start();
      const { call } = await script.begin();
      await call("ls", { path: "manuscript://" });
      await asWriter((writer) => writer.rename(LIVE, WRITER, CH1, "The Fall"));
      const fresh = await treeSeeder(db).document(SOURCE_ID, "ch1", { actor: WRITER });
      const refused = await call("write", { command: "delete", path: "ch1" });
      expect(text(refused)).toContain("status: path_changed; path: manuscript://ch1");
      expect(text(refused)).toContain(
        "Nothing done: manuscript://ch1 now names a different document. The one you were shown is now manuscript://The Fall.",
      );
      expect((await placement(CH1))?.deletedAt).toBeNull();
      expect((await placement(fresh))?.deletedAt).toBeNull();
      // The refusal showed both names: the old path now means the new document, the old one is reached by its new name.
      const deleted = await call("write", { command: "delete", path: "The Fall" });
      expect(deleted.isError, text(deleted)).toBeFalsy();
      expect((await placement(CH1))?.deletedAt).not.toBeNull();
      expect((await placement(fresh))?.deletedAt).toBeNull();
    });

    it("moves several into a folder, deletes it with what is inside, and restores it whole", async () => {
      const script = await start();
      const { call } = await script.begin();
      expect(text(await call("write", { command: "create", path: "Arc 2/" }))).toMatch(
        /^status: success; write: e\d+; version: live$/,
      );
      const moved = await call("write", {
        command: "move",
        from: { paths: ["ch1", "ch2", "missing"] },
        path: "Arc 2/",
      });
      expect(text(moved)).toContain("moved: 2 of 3");
      expect(text(moved)).toContain("not moved: manuscript://missing (not found)");
      const deleted = await call("write", { command: "delete", path: "Arc 2/" });
      expect(text(deleted)).toMatch(
        /^status: success; write: e\d+; version: live; deleted: 2 inside$/,
      );
      const { trashEntries } = script.runtime.ports;
      const lists = [await treeListOfSource(db, SOURCE_ID)];
      const entries = await trashEntries.list({ lists, view: LIVE });
      expect(entries).toMatchObject([{ name: "Arc 2", took: { documents: 2, folders: 1 } }]);
      const restored = await call("write", { command: "restore", path: "Arc 2/" });
      expect(restored.isError, text(restored)).toBeFalsy();
      expect(await trashEntries.list({ lists, view: LIVE })).toEqual([]);
      expect((await placement(CH2))?.deletedAt).toBeNull();
      // An undo of a delete names the path the model deleted.
      await call("write", { command: "delete", path: "Arc 2/" });
      const undone = await call("write", { command: "undo", path: "Arc 2/" });
      expect(text(undone), text(undone)).toContain("status: reversed");
      expect((await placement(CH2))?.deletedAt).toBeNull();
    });

    it("a draft can create, rename, reorder and delete folders; live stays as it was", async () => {
      const script = await start();
      await drafting(script).reply(async (edit) => {
        expect(await edit("write", { command: "create", path: "Arc 3/" })).toContain(
          "not applied yet",
        );
        await edit("write", { command: "move", from: { paths: ["ch1", "ch2"] }, path: "Arc 3/" });
        await edit("write", { command: "move", from: { path: "Arc 3/" }, path: "Part Three/" });
        await edit("write", {
          command: "move",
          from: { path: "Part Three/" },
          path: "Part Three/",
          position: { kind: "start" },
        });
      });
      const branch = await branchOf(OTHER_WORK_ID);
      const live = await store().read({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        view: ([{ writer }]) => [...writer.view(LIVE).nodes.values()].map((n) => n.displayName),
      });
      const work = await store().read({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        view: ([{ writer }]) =>
          [...writer.view({ draft: branch }).nodes.values()].map((n) => n.displayName),
      });
      expect(live).not.toContain("Part Three");
      expect(work).toContain("Part Three");
      expect(work).not.toContain("Arc 3");
      expect((await placement(CH1))?.name).toBe("ch1");
      await drafting(script).reply(async (edit) => {
        await edit("write", { command: "delete", path: "Part Three/" });
      });
    });

    describe("undo by the receipt", () => {
      it("takes back a live move, and redo does it again", async () => {
        const script = await start();
        const { call } = await script.begin();
        await call("write", { command: "move", from: { path: "ch1" }, path: "part1/ch1" });
        const undone = await call("write", { command: "undo", path: "part1/ch1" });
        expect(text(undone), text(undone)).toContain("status: reversed; path: manuscript://ch1");
        expect(await placement(CH1)).toMatchObject({ name: "ch1" });
        const redone = await call("write", { command: "redo", path: "ch1" });
        expect(text(redone)).toContain("status: reversed; path: manuscript://part1/ch1");
      });

      it("still takes back a drafted move after its Apply landed it", async () => {
        const script = await start();
        await drafting(script).reply(async (edit) => {
          await edit("write", { command: "move", from: { path: "ch1" }, path: "part1/ch1" });
        });
        expect(await review(script).apply(CH1)).toMatchObject({ status: "applied" });
        const { call } = await drafting(script).begin();
        const undone = await call("write", { command: "undo", path: "part1/ch1" });
        expect(text(undone), text(undone)).toContain("status: reversed");
        expect((await placement(CH1))?.name).toBe("ch1");
      });

      it("says nothing can be undone once the Work discarded the change", async () => {
        const script = await start();
        await drafting(script).reply(async (edit) => {
          await edit("write", { command: "move", from: { path: "ch1" }, path: "part1/ch1" });
        });
        await review(script).discard(CH1, { ends: "item" });
        const { call } = await drafting(script).begin();
        const undone = await call("write", { command: "undo", path: "ch1" });
        expect(undone.isError).toBe(true);
        expect(text(undone)).toContain("status: cant_undo_changed");
      });
    });

    /** What the reviewers' reproductions guard: each failed before the fixes, as written here. */
    describe("one Undo history, and a name that means the node it was shown as", () => {
      const asNewDoc = (name: string) =>
        treeSeeder(db).document(SOURCE_ID, name, { actor: WRITER });
      const live = async (script: Awaited<ReturnType<typeof start>>) => (await script.begin()).call;
      const ls = async (call: Awaited<ReturnType<typeof live>>, path: string) =>
        text(await call("ls", { path }));

      it("undo reaches a move by any moved document's path, and by count across text and tree", async () => {
        const script = await start();
        let { call } = await script.begin();
        await call("write", { command: "move", from: { paths: ["ch1", "ch2"] }, path: "part1/" });
        await call("write", { command: "replace", path: "part1/ch1", find: "one", content: "ONE" });
        // The text edit is the newest: it goes first, then the move is next, by a moved document's path.
        ({ call } = await script.begin());
        const first = await call("write", { command: "undo", path: "part1/ch1" });
        expect(text(first), text(first)).toContain("undone: e");
        const second = await call("write", { command: "undo", path: "part1/ch2" });
        expect(second.isError, text(second)).toBeFalsy();
        expect(text(second)).toContain("status: reversed; path: manuscript://ch2");
        expect(await ls(call, "manuscript://")).toContain("\n  ch1");
        // Redo of the move brings both back.
        expect(text(await call("write", { command: "redo", path: "ch1" }))).toContain(
          "status: reversed",
        );
        expect(await ls(call, "manuscript://part1/")).toContain("ch2");
        // count 2 takes a text edit and the move before it, in one call.
        await call("write", { command: "replace", path: "part1/ch1", find: "one", content: "1" });
        ({ call } = await script.begin());
        const both = await call("write", { command: "undo", path: "part1/ch1", count: 2 });
        expect(both.isError, text(both)).toBeFalsy();
        expect(await ls(call, "manuscript://")).toContain("\n  ch1");
        // A create with content is one command: one undo takes the node and its text, one redo both.
        call = await live(await start());
        await call("write", { command: "create", path: "born", content: "Fresh." });
        const gone = await call("write", { command: "undo", path: "born" });
        expect(gone.isError, text(gone)).toBeFalsy();
        expect(await ls(call, "manuscript://")).not.toContain("born");
        const back = await call("write", { command: "redo", path: "born" });
        expect(back.isError, text(back)).toBeFalsy();
        expect(text(await call("read", { path: "born" }))).toContain("Fresh.");
      });

      it("undoing a folder create leaves what the writer put in it, and the folder standing", async () => {
        const call = await live(await start());
        await call("write", { command: "create", path: "newfolder/" });
        await asWriter((writer) => {
          const folder = [...writer.view(LIVE).nodes.values()].find(
            (n) => n.displayName === "newfolder",
          );
          writer.create(LIVE, WRITER, {
            kind: "document",
            filetype: "markdown",
            name: "another",
            parent: folder?.id as string,
          });
        });
        const undone = await call("write", { command: "undo", path: "newfolder/" });
        expect(text(undone), text(undone)).toContain(
          "kept: manuscript://newfolder/ with manuscript://newfolder/another, added by the user",
        );
        expect(await ls(call, "manuscript://newfolder/")).toContain("another");
      });

      it("a refused move stores nothing", async () => {
        const call = await live(await start());
        const refused = await call("write", {
          command: "move",
          from: { path: "part1/" },
          path: "part1/new/part1/",
        });
        expect(text(refused)).toContain("inside itself");
        expect(await ls(call, "manuscript://part1/")).not.toContain("new/");
      });

      it("every printed path is a name shown: a read, a grep hit, and a listing record what they printed", async () => {
        const call = await live(await start());
        await call("ls", { path: "manuscript://" });
        await asWriter((writer) => writer.rename(LIVE, WRITER, CH1, "NewName"));
        expect(text(await call("read", { path: "ch1" }))).toContain("path: manuscript://NewName");
        await asWriter((writer) => writer.rename(LIVE, WRITER, CH1, "Third"));
        const fresh = await asNewDoc("NewName");
        const refused = await call("write", { command: "delete", path: "NewName" });
        expect(text(refused)).toContain("status: path_changed");
        expect((await placement(fresh))?.deletedAt).toBeNull();
      });

      it("grep records the paths it printed", async () => {
        const call = await live(await start());
        expect(
          text(await call("grep", { pattern: "Chapter one", path: "manuscript://" })),
        ).toContain("ch1");
        await asWriter((writer) => writer.rename(LIVE, WRITER, CH1, "Moved"));
        const fresh = await asNewDoc("ch1");
        const refused = await call("write", { command: "delete", path: "ch1" });
        expect(text(refused)).toContain("status: path_changed");
        expect((await placement(fresh))?.deletedAt).toBeNull();
      });

      it("a name shown in the other view and reused in this one is path_changed, not today's occupant", async () => {
        const script = await start();
        const shared = drafting(script);
        const draftEdit = await shared.begin();
        await draftEdit.call("write", { command: "create", path: "private/" });
        await asWriter((writer) =>
          writer.create(LIVE, WRITER, {
            kind: "folder",
            name: "private",
            parent: `source:${SOURCE_ID}`,
          }),
        );
        // The chat now writes live: the name it was shown in its draft means a different folder here.
        await db
          .update(schema.threads)
          .set({ aiWriteMode: "direct" })
          .where(eq(schema.threads.id, OTHER.threadId));
        const now = await shared.begin();
        const refused = await now.call("write", { command: "delete", path: "private/" });
        expect(text(refused), text(refused)).toContain("status: path_changed");
        expect((await placementsNamed("private")).every((row) => row.deletedAt === null)).toBe(
          true,
        );
      });

      it("a Discard entry names the folders it discarded from the discarded history", async () => {
        const script = await start();
        await drafting(script).reply(async (edit) => {
          await edit("write", { command: "create", path: "part1/inner/" });
        });
        const list = await treeListOfSource(db, SOURCE_ID);
        const command = randomUUID();
        await store().submit({
          lists: [list],
          make: ([{ writer }]) => {
            const ids = listRecords(writer.doc)
              .filter((record) => record.draft !== null && record.type === "create")
              .map((record) => record.id);
            writer.transact(() => writer.settle(WRITER, ids, "discarded", { command }));
          },
        });
        const entry = await discardedTree(store(), list, command);
        expect(entry.created).toMatchObject([
          { kind: "folder", name: "inner", path: ["part1", "inner"] },
        ]);
      });

      it("a move into a folder deleted since is made and the folder stands: kept, with who deleted it", async () => {
        const call = await live(await start());
        await call("ls", { path: "manuscript://part1/" });
        await call("ls", { path: "manuscript://" });
        await asWriter((writer) => {
          const folder = [...writer.view(LIVE).nodes.values()].find(
            (n) => n.displayName === "part1",
          );
          writer.delete(LIVE, WRITER, folder?.id as string);
        });
        const moved = await call("write", {
          command: "move",
          from: { path: "ch1" },
          path: "part1/ch1",
        });
        expect(moved.isError, text(moved)).toBeFalsy();
        expect(text(moved)).toContain(
          "kept: manuscript://part1/, deleted by the user after you last listed it",
        );
        expect((await placement(CH1))?.deletedAt).toBeNull();
      });

      it("restore reaches the Trash of its own source, and again brings the older one", async () => {
        const call = await live(await start());
        await call("write", { command: "delete", path: "ch1" });
        await call("write", { command: "delete", path: "scratch://@w2/sect-notes" });
        const refused = await call("write", { command: "restore", path: "sect-notes" });
        expect((await placement(SCRATCH_NOTE))?.deletedAt).not.toBeNull();
        expect(text(refused)).not.toContain("status: success");
        // Two deletes at one path: the newer first, then the older.
        const second = await asNewDoc("ch1");
        await asWriter((writer) => writer.delete(LIVE, WRITER, second));
        const first = await call("write", { command: "restore", path: "ch1" });
        expect(first.isError, text(first)).toBeFalsy();
        expect((await placement(second))?.deletedAt).toBeNull();
        const next = await call("write", { command: "restore", path: "ch1" });
        expect(next.isError, text(next)).toBeFalsy();
        expect((await placement(CH1))?.deletedAt).toBeNull();
      });

      it("a reply that only moved and created has a card, and its Undo and Redo take it back, across lists too", async () => {
        const script = await start();
        const { call } = await script.begin();
        await call("write", { command: "move", from: { path: "ch1" }, path: "user://mine" });
        await call("write", { command: "move", from: { path: "ch2" }, path: "part1/" });
        await call("write", { command: "create", path: "fresh", content: "Hi." });
        const sync = composed.ports.documentSync;
        const listed = await sync.listEditedDocumentsForTurn(
          THREAD.threadId as never,
          THREAD.turnId as never,
        );
        expect(listed.map((document) => document.documentId)).toEqual(
          expect.arrayContaining([CH1, CH2] as never[]),
        );
        const chip = await sync.getTurnReceiptChip(
          THREAD.threadId as never,
          THREAD.turnId as never,
        );
        expect(chip).toMatchObject({ control: "undo" });
        const card = (direction: "undo" | "redo", commandId = randomUUID()) =>
          reverseTurnCard(
            {
              ...composed.ports,
              workContextNotices: { workChanged: async () => {} },
              stopThreads: async () => {},
            },
            {
              threadId: THREAD.threadId as never,
              turnId: THREAD.turnId as never,
              userId: USER_ID as never,
              direction,
              commandId: commandId as never,
            },
          );
        const clicked = randomUUID();
        const undone = await card("undo", clicked);
        expect(undone.status, JSON.stringify(undone)).toBe("reversed");
        const receipts = async () => (await db.select().from(schema.treeEditReceipts)).length;
        const stored = await receipts();
        // The same click again answers its stored outcome and appends nothing.
        expect(await card("undo", clicked)).toEqual(undone);
        expect(await receipts()).toBe(stored);
        const { call: after } = await script.begin();
        expect(await ls(after, "manuscript://")).toContain("ch1");
        expect(await ls(after, "manuscript://")).toContain("ch2");
        expect(await ls(after, "manuscript://")).not.toContain("fresh");
        expect(await ls(after, "user://")).not.toContain("mine");
        const redoChip = await sync.getTurnReceiptChip(
          THREAD.threadId as never,
          THREAD.turnId as never,
        );
        expect(redoChip).toMatchObject({ control: "redo" });
        const redone = await card("redo");
        expect(redone.status, JSON.stringify(redone)).toBe("reversed");
        expect(await ls(after, "user://")).toContain("mine");
        expect(await ls(after, "manuscript://part1/")).toContain("ch2");
        expect(await ls(after, "manuscript://")).toContain("fresh");
      });

      it("a Copy's operation id: a resend answers the stored result, another request or another account's is command_conflict", async () => {
        const { createCopyCommands } = await import("../domains/context/copy/copy-commands.js");
        const other = {
          user: "00000000-0000-4000-8000-000000000d71",
          project: "00000000-0000-4000-8000-000000000d72",
        };
        await db.insert(schema.users).values(conformanceUserValues(other.user, "copy-other"));
        await db.insert(schema.projects).values({
          id: other.project,
          userId: other.user,
          name: "B",
          slug: "copy-b",
          isPersonal: true,
        });
        const mine = createCopyCommands(db, { userId: USER_ID, projectId: PROJECT_ID });
        const theirs = createCopyCommands(db, { userId: other.user, projectId: other.project });
        const copyTo = (destinationUri: string) => ({
          kind: "copy" as const,
          sources: [],
          destinationUri,
        });
        const copied = { ok: true, value: { created: [] } } as never;
        const conflict = (uri: string) => ({ ok: false, error: { code: "command_conflict", uri } });
        const id = randomUUID();
        let ran = 0;
        const run = async () => {
          ran += 1;
          return copied;
        };
        expect(await mine.execute(id, copyTo("manuscript://a/"), "manuscript://a/", run)).toEqual(
          copied,
        );
        expect(await mine.execute(id, copyTo("manuscript://a/"), "manuscript://a/", run)).toEqual(
          copied,
        );
        expect(await mine.execute(id, copyTo("manuscript://b/"), "manuscript://b/", run)).toEqual(
          conflict("manuscript://b/"),
        );
        expect(await theirs.execute(id, copyTo("manuscript://a/"), "manuscript://a/", run)).toEqual(
          conflict("manuscript://a/"),
        );
        expect(ran).toBe(1);
      });

      it("a document moves to the account's files and back, and Undo takes it back across both lists", async () => {
        const call = await live(await start());
        const moved = await call("write", {
          command: "move",
          from: { path: "ch1" },
          path: "user://mine",
        });
        expect(moved.isError, text(moved)).toBeFalsy();
        expect(await ls(call, "user://")).toContain("mine");
        const undone = await call("write", { command: "undo", path: "user://mine" });
        expect(undone.isError, text(undone)).toBeFalsy();
        expect(await ls(call, "manuscript://")).toContain("ch1");
        const redone = await call("write", { command: "redo", path: "ch1" });
        expect(redone.isError, text(redone)).toBeFalsy();
        expect(await ls(call, "user://")).toContain("mine");
      });
    });

    describe("a card Undo of a turn that made a Work and edited a document", () => {
      const NEW_WORK_ID = "00000000-0000-4000-8000-000000000d20";
      const NEW_WORK_THREAD = "00000000-0000-4000-8000-000000000d21";

      /** The turn made Work "Fresh" (its receipt) and replaced the text of ch1. */
      async function madeWorkAndEdited() {
        const script = await start();
        await db.insert(schema.works).values({
          id: NEW_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Fresh",
          handle: "w3",
        });
        await db.insert(schema.threads).values({
          rootThreadId: NEW_WORK_THREAD,
          id: NEW_WORK_THREAD,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Fresh",
          kind: "primary",
          status: "idle",
          aiWriteMode: "direct",
        });
        await db.insert(schema.threadWorks).values({
          threadId: NEW_WORK_THREAD,
          workId: NEW_WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
        await db.insert(schema.turnBlocks).values({
          id: randomUUID(),
          turnId: THREAD.turnId,
          blockType: "custom",
          sequence: 1,
          content: {
            metadata: {
              workReceipt: {
                operation: "create",
                changed: true,
                workId: NEW_WORK_ID,
                workName: "Fresh",
                before: null,
                after: { name: "Fresh", goal: null, status: null, archived: false },
                inverse: { command: "delete", workId: NEW_WORK_ID },
              },
            },
          },
        } as never);
        await script.reply(async (edit) => {
          await edit("write", { command: "replace", path: "ch1", find: "one", content: "ONE" });
        });
        return script;
      }
      const card = (
        script: Awaited<ReturnType<typeof start>>,
        direction: "undo" | "redo",
        commandId = randomUUID(),
        thread = THREAD,
      ) =>
        reverseTurnCard(
          {
            ...script.runtime.ports,
            workContextNotices: { workChanged: async () => {} },
            stopThreads: script.runtime.app.stopThreads,
          },
          {
            threadId: thread.threadId as never,
            turnId: thread.turnId as never,
            userId: USER_ID as never,
            direction,
            commandId: commandId as never,
          },
        );
      const workDeleted = async () =>
        (
          await db
            .select({ deletedAt: schema.works.deletedAt })
            .from(schema.works)
            .where(eq(schema.works.id, NEW_WORK_ID))
        )[0]?.deletedAt != null;
      const ch1 = async (script: Awaited<ReturnType<typeof start>>) => script.text("ch1", "live");
      const claims = async () =>
        (await db.select().from(schema.commands).where(eq(schema.commands.kind, "reverse_turn")))
          .length;

      it("takes back the document and the Work in one command, and a resend answers it", async () => {
        const script = await madeWorkAndEdited();
        expect(await ch1(script)).toContain("ONE");
        const id = randomUUID();
        const undone = await card(script, "undo", id);
        expect(undone.workReceipts, JSON.stringify(undone)).toEqual([
          expect.objectContaining({ workId: NEW_WORK_ID, status: "reversed" }),
        ]);
        expect(undone.acceptedParts).toBeGreaterThan(0);
        expect(await workDeleted()).toBe(true);
        expect(await ch1(script)).toContain("one");
        expect(await claims()).toBe(1);
        // The same click again: the stored answer, nothing done twice.
        expect(await card(script, "undo", id)).toEqual(undone);
        expect(await claims()).toBe(1);
        const redone = await card(script, "redo");
        expect(redone.workReceipts).toEqual([
          expect.objectContaining({ workId: NEW_WORK_ID, status: "redone" }),
        ]);
        expect(await workDeleted()).toBe(false);
        expect(await ch1(script)).toContain("ONE");
      });

      it("a crash after the documents and before the commit leaves neither half", async () => {
        const script = await madeWorkAndEdited();
        const id = randomUUID();
        const remove = setTestHook("command.beforeCommit", async () => {
          throw new Error("crash between the halves");
        });
        try {
          await expect(card(script, "undo", id)).rejects.toThrow("crash between the halves");
        } finally {
          remove();
        }
        expect(await workDeleted()).toBe(false);
        expect(await ch1(script)).toContain("ONE");
        expect(await claims()).toBe(0);
        // The id is free: the same click, sent again, takes effect once.
        const undone = await card(script, "undo", id);
        expect(undone.workReceipts?.[0]?.status).toBe("reversed");
        expect(await workDeleted()).toBe(true);
        expect(await ch1(script)).toContain("one");
      });

      it("against a Work delete of the same Work: one waits for the other, neither deadlocks", async () => {
        const script = await madeWorkAndEdited();
        const { app } = script.runtime;
        const raced = await race<"undo" | "delete">(
          db,
          {
            undo: () => card(script, "undo"),
            delete: () =>
              runWorkLifecycleCommand(app.works.transaction, () =>
                app.works.softDelete(NEW_WORK_ID as never, app.stopThreads),
              ),
          },
          "undo",
          "inverse.beforeCommitScope",
        );
        expect(raced.by.undo).toMatchObject({ ok: true });
        expect(raced.by.delete).toMatchObject({ ok: true });
        expect(raced.bWaited).toBe(true);
        expect(await workDeleted()).toBe(true);
        expect(await ch1(script)).toContain("one");
      });

      it("against the runtime's thread lock on the made Work's chat: neither deadlocks", async () => {
        const script = await madeWorkAndEdited();
        const threadLock = createDrizzleThreadLock(db);
        const raced = await race<"undo" | "inbox">(
          db,
          {
            undo: () => card(script, "undo"),
            inbox: () => threadLock.withThreadLock(NEW_WORK_THREAD as never, async () => "held"),
          },
          "undo",
          "inverse.beforeCommitScope",
        );
        expect(raced.by.undo, JSON.stringify(raced.by.undo)).toMatchObject({ ok: true });
        expect(raced.by.inbox, JSON.stringify(raced.by.inbox)).toMatchObject({ ok: true });
        expect(raced.bWaited).toBe(true);
        expect(await workDeleted()).toBe(true);
      });

      it("against a second reversal in the same chat: the second reads what the first left", async () => {
        const script = await madeWorkAndEdited();
        const raced = await race<"first" | "second">(
          db,
          { first: () => card(script, "undo"), second: () => card(script, "undo") },
          "first",
          "inverse.beforeCommitScope",
        );
        expect(raced.by.first).toMatchObject({ ok: true });
        expect(raced.by.second).toMatchObject({ ok: true });
        expect(raced.bWaited).toBe(true);
        expect(await claims()).toBe(2);
        expect(await workDeleted()).toBe(true);
        expect(await ch1(script)).toContain("one");
      });

      it("a draft that joins the document between declare and commit reruns the command with its Work", async () => {
        const script = await madeWorkAndEdited();
        const other = runtimes.script(script.runtime, OTHER);
        let claimed = 0;
        const count = setTestHook("inverse.beforeCommitScope", async () => {
          claimed += 1;
        });
        try {
          const raced = await race<"undo" | "draft">(
            db,
            {
              undo: () => card(script, "undo"),
              draft: () =>
                other.reply(async (edit) => {
                  await edit("write", {
                    command: "replace",
                    path: "ch1",
                    find: "Chapter",
                    content: "Part",
                  });
                }),
            },
            "undo",
            "inverse.afterCaptureRead",
          );
          expect(raced.by.undo, JSON.stringify(raced.by.undo)).toMatchObject({ ok: true });
          expect(raced.by.draft).toMatchObject({ ok: true });
        } finally {
          count();
        }
        // The first attempt declared no draft Work; its commit found one, and the command ran again.
        expect(claimed).toBe(2);
        expect(await claims()).toBe(1);
        expect(await workDeleted()).toBe(true);
      });
    });
  });
}
