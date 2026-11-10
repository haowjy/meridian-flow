/** PostgreSQL coverage for the chats-of-a-document read and the recent-documents `edited` flag. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../../test-support/thread-work-postgres-harness.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("document related read (postgres)", () => {});
} else {
  describe("document related read (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { createDrizzleDocumentRelatedReader } = await import("./document-related-reader.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const reader = createDrizzleDocumentRelatedReader(db);
    const ids = THREAD_WORK_RACE;
    const STRANGER = "00000000-0000-4000-8000-000000000481";
    const STRANGER_PROJECT = "00000000-0000-4000-8000-000000000482";

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
    });
    afterAll(() => db.close());

    const list = () =>
      reader.listChats({
        documentId: ids.documentId,
        projectId: ids.projectId,
        userId: ids.userId,
        limit: 20,
      });

    async function chat(title: string) {
      return repos.threads.create({
        aiWriteMode: "direct",
        userId: ids.userId,
        projectId: ids.projectId,
        title,
      });
    }
    async function touch(threadId: string) {
      const turn = await repos.turns.create({
        threadId: threadId as never,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await repos.documentTouches.recordTouch(turn.id, ids.documentId);
    }
    async function edit(
      threadId: string,
      over: Partial<typeof schema.documentEdits.$inferInsert> = {},
    ) {
      await db.insert(schema.documentEdits).values({
        documentId: ids.documentId,
        threadId: threadId as never,
        actor: "agent",
        kind: "write",
        ...over,
      });
    }
    async function subagentOf(parentId: string) {
      const turn = await repos.turns.create({
        threadId: parentId as never,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const child = await repos.threads.createSubagent({
        aiWriteMode: "direct",
        userId: ids.userId,
        projectId: ids.projectId,
        parentThreadId: parentId as never,
        rootThreadId: parentId as never,
        originTurnId: turn.id,
        spawnDepth: 1,
      });
      return child.id as string;
    }

    it("lists chats newest first, flagging the ones that wrote", async () => {
      const older = await chat("Older");
      const newer = await chat("Newer");
      await touch(older.id);
      await edit(older.id);
      await touch(newer.id);
      const chats = await list();
      expect(chats.map((c) => [c.title, c.edited])).toEqual([
        ["Newer", false],
        ["Older", true],
      ]);
    });

    it("credits a subagent's edit to the chat that spawned it", async () => {
      const parent = await chat("Parent");
      const sub = await subagentOf(parent.id);
      await edit(sub);
      expect(await list()).toMatchObject([{ chatId: parent.id, edited: true }]);
    });

    it("credits a fork's edit to the fork, not to the chat it forked from", async () => {
      const source = await chat("Source");
      const sourceTurn = await repos.turns.create({
        threadId: source.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const { thread: fork } = await repos.threads.createDerivedPrimary({
        aiWriteMode: "direct",
        id: crypto.randomUUID() as never,
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        source,
        originType: "fork",
        originTurnId: sourceTurn.id,
        title: "Fork",
      });
      await edit(fork.id);
      expect(await list()).toMatchObject([{ chatId: fork.id, title: "Fork", edited: true }]);
    });

    it("does not count undo, redo, revert or rollback rows, or a human's edit, as an edit", async () => {
      const c = await chat("Chat");
      await touch(c.id);
      for (const kind of ["undo", "redo", "revert", "rollback"] as const) {
        await edit(c.id, { kind });
      }
      await edit(c.id, { actor: "human" });
      await edit(c.id, { treeChange: { kind: "move" } as never });
      expect(await list()).toMatchObject([{ chatId: c.id, edited: false }]);
      expect(await repos.documentTouches.listByThread(c.id)).toMatchObject([{ edited: false }]);
    });

    it("leaves out a trashed chat, another account's chat and another project's chat", async () => {
      const trashed = await chat("Trashed");
      await edit(trashed.id);
      await repos.threads.setTrashState(trashed.id, "deleted");
      await db.insert(schema.users).values(conformanceUserValues(STRANGER, "related-stranger"));
      await db
        .insert(schema.projects)
        .values({ id: STRANGER_PROJECT, userId: STRANGER, name: "Theirs", slug: "theirs" });
      const foreign = await repos.threads.create({
        aiWriteMode: "direct",
        userId: STRANGER,
        projectId: STRANGER_PROJECT,
        title: "Foreign",
      });
      await edit(foreign.id);
      expect(await list()).toEqual([]);
    });

    it("lists a document on the chat's recent documents when it only has an edit", async () => {
      const parent = await chat("Parent");
      const sub = await subagentOf(parent.id);
      await edit(sub);
      expect(await repos.documentTouches.listByThread(parent.id)).toMatchObject([
        { documentId: ids.documentId, threadId: parent.id, edited: true },
      ]);
    });

    it("lists mentions of documents that existed, or settled later, when the link was written", async () => {
      const direct = crypto.randomUUID();
      const settled = crypto.randomUUID();
      const unsettled = crypto.randomUUID();
      for (const id of [direct, settled]) {
        await db
          .insert(schema.documents)
          .values({ id: id as never, contextSourceId: ids.contextId, name: id });
      }
      await db.insert(schema.linkAheadRefs).values([
        {
          aheadId: settled,
          projectId: ids.projectId,
          scheme: "manuscript",
          path: "a",
          settledDocumentId: settled as never,
        },
        { aheadId: unsettled, projectId: ids.projectId, scheme: "manuscript", path: "b" },
      ]);
      await db.insert(schema.documentLinks).values([
        {
          sourceDocumentId: ids.documentId,
          linkKey: `doc:${direct}`,
          targetDocumentId: direct as never,
          occurrences: 2,
        },
        {
          sourceDocumentId: ids.documentId,
          linkKey: `ahead:${settled}`,
          aheadId: settled,
          occurrences: 3,
        },
        {
          sourceDocumentId: ids.documentId,
          linkKey: `ahead:${unsettled}`,
          aheadId: unsettled,
          occurrences: 5,
        },
      ]);
      expect(await reader.listMentions(ids.documentId)).toEqual([
        { documentId: settled, occurrences: 3 },
        { documentId: direct, occurrences: 2 },
      ]);
    });

    it("reports a subagent's touch and edit on the chat's recent documents", async () => {
      const parent = await chat("Parent");
      const sub = await subagentOf(parent.id);
      await touch(sub);
      await edit(sub);
      const docs = await repos.documentTouches.listByThread(parent.id);
      expect(docs).toMatchObject([
        { documentId: ids.documentId, threadId: parent.id, edited: true },
      ]);
    });
  });
}
