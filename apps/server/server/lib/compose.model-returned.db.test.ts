/**
 * The AI's edit that cannot land is answered, not refused: the writer deleted the document or a
 * paragraph, or the Work is closed. (An edit the writer's Discard left behind lands in a new draft.)
 * The call is a plain `done` command row that says `returned`, nothing opens, nothing is journalled, and the result
 * shows the document as it now stands, so the model's next edit lands.
 */
import { randomUUID } from "node:crypto";
import { createReplyMutations } from "@meridian/agent-edit/integration";
import { toolContentText } from "@meridian/contracts/threads";
import { LIVE } from "@meridian/project-tree";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import {
  CreditedBlocks,
  frontierLookup,
  recordStoredResult,
  shownNamesLookup,
} from "../domains/runtime/loop/frontier-recording.js";
import { setTestHook } from "../shared/test-hooks.js";
import { treeListOfSource, treeSeeder } from "../test-support/tree-seed.js";
import { reverseTurnCard } from "./work-receipt-reversal.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("the AI's returned edits (postgres)", () => {});
} else {
  describe("the AI's returned edits (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDb } = await import("@meridian/database");
    const { deleteDrizzleRows } = await import("../test-support/drizzle-reset.js");
    const { bindEditAgent, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );
    const { handleOwnerDraftListRequest, handlePressRequest, selectBranchRouteServices } =
      await import("./branch-review-route.js");

    const USER_ID = "00000000-0000-4000-8000-000000000e01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000e02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000e03";
    const WORK_ID = "00000000-0000-4000-8000-000000000e04";
    const DRAFTING = {
      threadId: "00000000-0000-4000-8000-000000000e05",
      turnId: "00000000-0000-4000-8000-000000000e06",
    };
    const LIVE_CHAT = {
      threadId: "00000000-0000-4000-8000-000000000e07",
      turnId: "00000000-0000-4000-8000-000000000e08",
    };
    const CH1 = "00000000-0000-4000-8000-000000000e09";
    const BODY = "Alpha one.\n\nBravo two.\n\nCharlie three.";

    const db = createDb(DATABASE_URL, { max: 6 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "model-returned"));
      await db.execute(sql`UPDATE users SET name = 'Ana' WHERE id = ${USER_ID}`);
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Returned",
        slug: "returned",
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
      ]);
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        slug: "manuscript",
        scope: "project",
      });
      await treeSeeder(db).document(SOURCE_ID, "ch1", { id: CH1 });
      for (const [chat, mode] of [
        [DRAFTING, "draft"],
        [LIVE_CHAT, "direct"],
      ] as const) {
        await db.insert(schema.threads).values({
          rootThreadId: chat.threadId,
          id: chat.threadId,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: `${mode} chat`,
          kind: "primary",
          aiWriteMode: mode,
        });
        await db.insert(schema.turns).values({
          id: chat.turnId,
          threadId: chat.threadId,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await db.insert(schema.threadWorks).values({
          threadId: chat.threadId,
          workId: WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
      }
    });

    /** One model reply as the loop runs it: frontiers credit the blocks the reply carries. */
    async function reply(chat: typeof DRAFTING) {
      const runtime = await runtimes.compose();
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: CH1,
        markdown: BODY,
        origin: { type: "user", actorUserId: USER_ID },
        threadId: chat.threadId,
      });
      await bindEditAgent(runtime, chat.threadId);
      const deps = {
        documentEvidence: runtime.ports.documentSync.modelEvidence(),
        eventSink: createNoopEventSink(),
      };
      const credited = new CreditedBlocks();
      const correlation = { threadId: chat.threadId, turnId: chat.turnId };
      const owner = { projectId: PROJECT_ID as never, ...correlation };
      const responseId = await runtimes.insertModelResponse(chat);
      const mutations = createReplyMutations();
      const call = async (name: string, args: Record<string, unknown>, id = randomUUID()) => {
        const result = await runtime.app.toolExecutor.executeTool(
          { id, name, arguments: args },
          {
            ...chat,
            responseIdentity: { modelResponseId: responseId },
            commandOwner: { accountId: USER_ID as never, projectId: PROJECT_ID as never },
            agentSlug: null,
            shownNames: shownNamesLookup(deps, () => credited.ids(), correlation),
            frontiers: {
              recording: frontierLookup(deps, () => credited.ids(), correlation),
              planning: frontierLookup(deps, () => credited.ids(), correlation),
              credited: () => credited.ids(),
              reply: mutations,
            },
          },
        );
        const blockId = result.blockId ?? randomUUID();
        if (result.evidence)
          await recordStoredResult(deps, owner, blockId as never, result.evidence);
        credited.add(blockId);
        return { ...result, text: toolContentText(result.content) };
      };
      return { runtime, call };
    }

    const modelEditRows = () =>
      db
        .select({ outcome: schema.commands.outcome })
        .from(schema.commands)
        .where(eq(schema.commands.kind, "model_edit"))
        .orderBy(schema.commands.createdAt);
    const branchRows = () => db.select({ id: schema.branches.id }).from(schema.branches);
    const hashOf = (read: string, word: string) =>
      read
        .split("\n")
        .find((line) => line.includes(word))
        ?.split("|")[0] as string;

    async function writerDiscards(runtime: Awaited<ReturnType<typeof reply>>["runtime"]) {
      const routes = selectBranchRouteServices(runtime.app);
      const scope = { userId: USER_ID, projectId: PROJECT_ID } as const;
      const listed = await handleOwnerDraftListRequest(routes, {
        ...scope,
        owner: `work:${WORK_ID}`,
      } as never);
      if (!listed.items.some((item) => item.documentId === CH1))
        throw new Error("the model's edit made no draft to discard");
      await handlePressRequest(routes, {
        ...scope,
        request: {
          commandId: randomUUID(),
          owner: `work:${WORK_ID}`,
          verdict: "discard",
          items: [{ node: CH1 }],
        },
      } as never);
    }

    it("the writer discards the draft mid-round: the next edit lands in the same draft", async () => {
      const { runtime, call } = await reply(DRAFTING);
      const read = await call("read", { path: "ch1" });
      const first = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Bravo two.",
        content: "Bravo, edited.",
      });
      expect(first.isError, first.text).toBeFalsy();
      await writerDiscards(runtime);
      const earlier = await branchRows();

      const replayId = randomUUID();
      const args = {
        command: "replace",
        path: "ch1",
        find: "Charlie three.",
        content: "Charlie, edited.",
      };
      const landed = await call("write", args, replayId);
      expect(landed.isError, landed.text).toBeFalsy();
      expect(landed.text).toContain("status: success");
      expect(landed.text).not.toMatch(/re-read|retry|read again/i);
      // A Discard closes no draft: the write lands in the Work's one branch.
      expect(await branchRows()).toHaveLength(earlier.length);
      const listed = await handleOwnerDraftListRequest(selectBranchRouteServices(runtime.app), {
        userId: USER_ID,
        projectId: PROJECT_ID,
        owner: `work:${WORK_ID}`,
      } as never);
      expect(listed.items.find((item) => item.documentId === CH1)?.actorThreads).toEqual([
        expect.objectContaining({ threadId: DRAFTING.threadId }),
      ]);
      const rows = await modelEditRows();
      const last = rows.at(-1)?.outcome as never as {
        status: string;
        result: { settled?: unknown };
      };
      expect(last.status).toBe("done");
      expect(last.result.settled).toBeUndefined();

      // A crash between the row's commit and the answer: the call, sent again under its id,
      // reads the same row and the same text.
      const replayed = await call("write", args, replayId);
      expect(replayed.text).toBe(landed.text);
      expect((await modelEditRows()).length).toBe(rows.length);
      expect(read.text).toContain("Alpha one.");
    });

    it("the writer deletes a paragraph: an edit to it is returned with the document", async () => {
      const { runtime, call } = await reply(LIVE_CHAT);
      const read = await call("read", { path: "ch1" });
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: CH1,
        markdown: "Alpha one.\n\nCharlie three.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: LIVE_CHAT.threadId,
      });
      const bravo = hashOf(read.text, "Bravo");
      const returned = await call("write", {
        command: "replace",
        path: "ch1",
        in: bravo,
        content: "Bravo, edited.",
      });
      expect(returned.isError, returned.text).toBeFalsy();
      expect(returned.text).toContain("status: returned");
      expect(returned.text).toContain("Charlie three.");
      expect(returned.text).not.toContain("Bravo two.");
    });

    it("an insert after a paragraph the writer deleted lands where it was, and the writer's text is whole", async () => {
      const { runtime, call } = await reply(LIVE_CHAT);
      const read = await call("read", { path: "ch1" });
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: CH1,
        markdown: "Alpha one.\n\nCharlie three.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: LIVE_CHAT.threadId,
      });
      const bravo = hashOf(read.text, "Bravo");
      const landed = await call("write", {
        command: "insert",
        path: "ch1",
        after: bravo,
        content: "Between them.",
      });
      expect(landed.isError, landed.text).toBeFalsy();
      const now = await call("read", { path: "ch1" });
      const lines = now.text.split("\n").map((line) => line.split("|").slice(1).join("|"));
      const text = lines.filter(Boolean);
      expect(text).toContain("Alpha one.");
      expect(text).toContain("Charlie three.");
      expect(text).toContain("Between them.");
      expect(text).not.toContain("Bravo two.");
      expect(text.indexOf("Between them.")).toBeGreaterThan(text.indexOf("Alpha one."));
      expect(text.indexOf("Between them.")).toBeLessThan(text.indexOf("Charlie three."));
    });

    it("a write after the writer deleted the document is returned, naming who, and none of it is a refusal", async () => {
      const { call } = await reply(LIVE_CHAT);
      await call("read", { path: "ch1" });
      await treeSeeder(db).store.submit({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        make: ([{ writer }]) => writer.delete(LIVE, `user:${USER_ID}`, CH1),
      });
      for (const args of [
        { command: "replace", path: "ch1", find: "Alpha one.", content: "Alpha, edited." },
        { command: "insert", path: "ch1", after: "Alpha one.", content: "More." },
      ]) {
        const answer = await call("write", args);
        expect(answer.isError, `${args.command}: ${answer.text}`).toBeFalsy();
        expect(answer.text, args.command).toContain("status: returned");
        expect(answer.text, args.command).toContain("deleted by Ana");
      }
      expect(JSON.stringify((await modelEditRows()).slice(-1))).toContain("document_removed");
    });

    it("the writer deletes the folder a document is in: a write, undo and revert name the document", async () => {
      const CH2 = "00000000-0000-4000-8000-000000000e0a";
      await treeSeeder(db).document(SOURCE_ID, "Part/ch2", { id: CH2 });
      const { runtime, call } = await reply(LIVE_CHAT);
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: CH2,
        markdown: "Delta four.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: LIVE_CHAT.threadId,
      });
      const read = await call("read", { path: "Part/ch2" });
      expect(read.isError, read.text).toBeFalsy();
      const part = await treeSeeder(db).folder(SOURCE_ID, "Part");
      await treeSeeder(db).store.submit({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        make: ([{ writer }]) => writer.delete(LIVE, `user:${USER_ID}`, part),
      });
      for (const args of [
        { command: "replace", path: "Part/ch2", find: "Delta four.", content: "Delta, edited." },
        { command: "undo", path: "Part/ch2" },
        { command: "revert", path: "Part/ch2", edit: "e1" },
      ]) {
        const answer = await call("write", args);
        expect(answer.isError, `${args.command}: ${answer.text}`).toBeFalsy();
        expect(answer.text, args.command).toContain("status: returned");
        expect(answer.text, args.command).toContain("deleted by Ana");
        expect(answer.text, args.command).not.toContain("File not found");
      }
    });

    it("the writer deletes the document under the edit: it is returned, naming who", async () => {
      const { call } = await reply(LIVE_CHAT);
      await call("read", { path: "ch1" });
      // The path resolved when the call began; the delete lands before the edit takes its lock.
      let deleted = false;
      const remove = setTestHook("command.afterClaim", async () => {
        if (deleted) return;
        deleted = true;
        await treeSeeder(db).store.submit({
          lists: [await treeListOfSource(db, SOURCE_ID)],
          make: ([{ writer }]) => writer.delete(LIVE, `user:${USER_ID}`, CH1),
        });
      });
      const returned = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Alpha one.",
        content: "Alpha, edited.",
      });
      remove();
      expect(returned.isError, returned.text).toBeFalsy();
      expect(returned.text).toContain("status: returned");
      expect(returned.text).toContain("deleted by Ana");
      const [last] = (await modelEditRows()).slice(-1);
      expect(JSON.stringify(last?.outcome)).toContain("document_removed");
    });

    it("a failed apply or commit runs once more under the same id; a second failure says the edit did not land", async () => {
      const { call } = await reply(LIVE_CHAT);
      await call("read", { path: "ch1" });
      let failures = 0;
      const remove = setTestHook("command.afterClaim", async () => {
        failures += 1;
        if (failures === 1) throw new Error("transient");
      });
      const once = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Alpha one.",
        content: "Alpha, edited.",
      });
      remove();
      expect(once.isError, once.text).toBeFalsy();
      expect(once.text).toContain("status: success");
      expect(failures).toBe(2);
      const rows = await modelEditRows();
      expect(rows).toHaveLength(1);

      let attempts = 0;
      const always = setTestHook("command.afterClaim", async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error("down");
      });
      const twice = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Bravo two.",
        content: "Bravo, edited.",
      });
      always();
      expect(twice.isError).toBe(true);
      expect(twice.text).toContain("did not land");
      expect(twice.text).not.toMatch(/retry|again|re-?read/i);
    });

    it("a Copy whose first attempt rolled back links the copy to the document that committed", async () => {
      const { runtime, call } = await reply(LIVE_CHAT);
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: CH1,
        markdown: "[Self](manuscript://ch1)",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: LIVE_CHAT.threadId,
      });
      await call("read", { path: "ch1" });
      let failures = 0;
      const remove = setTestHook("command.beforeCommit", async () => {
        failures += 1;
        if (failures === 1) throw new Error("transient");
      });
      const copied = await call("write", { command: "copy", from: { path: "ch1" }, path: "copy" });
      remove();
      expect(copied.isError, copied.text).toBeFalsy();
      expect(failures).toBe(2);
      const moved = await call("write", {
        command: "move",
        from: { path: "copy" },
        path: "renamed",
      });
      expect(moved.isError, moved.text).toBeFalsy();
      const now = await call("read", { path: "renamed" });
      expect(now.text).toContain("[Self](renamed)");
    });

    it("undo and revert on a document the writer deleted are returned, naming who", async () => {
      const { call } = await reply(LIVE_CHAT);
      await call("read", { path: "ch1" });
      const landed = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Alpha one.",
        content: "Alpha, edited.",
      });
      expect(landed.isError, landed.text).toBeFalsy();
      await treeSeeder(db).store.submit({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        make: ([{ writer }]) => writer.delete(LIVE, `user:${USER_ID}`, CH1),
      });
      for (const args of [
        { command: "undo", path: "ch1" },
        { command: "revert", path: "ch1", edit: "e1" },
      ]) {
        const answer = await call("write", args);
        expect(answer.isError, `${args.command}: ${answer.text}`).toBeFalsy();
        expect(answer.text, args.command).toContain("status: returned");
        expect(answer.text, args.command).toContain("deleted by Ana");
      }
    });

    it("the turn's Undo takes back what landed and leaves the returned edit out cleanly", async () => {
      const { runtime, call } = await reply(LIVE_CHAT);
      const read = await call("read", { path: "ch1" });
      const landed = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Alpha one.",
        content: "Alpha, edited.",
      });
      expect(landed.isError, landed.text).toBeFalsy();
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: CH1,
        markdown: "Alpha, edited.\n\nCharlie three.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: LIVE_CHAT.threadId,
      });
      const returned = await call("write", {
        command: "replace",
        path: "ch1",
        in: hashOf(read.text, "Bravo"),
        content: "Bravo, edited.",
      });
      expect(returned.text).toContain("status: returned");
      const undone = await reverseTurnCard(
        {
          ...runtime.ports,
          workContextNotices: { workChanged: async () => {} },
          stopThreads: async () => {},
        },
        {
          threadId: LIVE_CHAT.threadId as never,
          turnId: LIVE_CHAT.turnId as never,
          userId: USER_ID as never,
          commandId: randomUUID() as never,
        },
      );
      expect(undone.status).toBe("reversed");
      const now = await call("read", { path: "ch1" });
      expect(now.text).toContain("Alpha one.");
      expect(now.text).toContain("Charlie three.");
    });
  });
}
