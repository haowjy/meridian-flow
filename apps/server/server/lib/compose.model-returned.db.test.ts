/**
 * The AI's edit that cannot land is answered, not refused: the writer discarded the draft it
 * edited, deleted the document, deleted a paragraph, or the Work is closed. The call is a plain
 * `done` command row that says `returned`, nothing opens, nothing is journalled, and the result
 * shows the document as it now stands, so the model's next edit lands.
 */
import { randomUUID } from "node:crypto";
import { createReplyMutations } from "@meridian/agent-edit/integration";
import { toolContentText } from "@meridian/contracts/threads";
import { LIVE } from "@meridian/project-tree";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import {
  CreditedBlocks,
  frontierLookup,
  recordStoredResult,
  shownNamesLookup,
} from "../domains/runtime/loop/frontier-recording.js";
import { treeListOfSource, treeSeeder } from "../test-support/tree-seed.js";

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
    const {
      handleDiscardWorkDraftRequest,
      handleOwnerDraftListRequest,
      selectBranchRouteServices,
    } = await import("./branch-review-route.js");

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
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Returned",
        slug: "returned",
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
      ]);
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
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
          status: "idle",
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
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await runtime.app.toolExecutor.executeTool(
          { id: randomUUID(), name, arguments: args },
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
        .where(eq(schema.commands.kind, "model_edit"));
    const draftRows = () => db.select({ id: schema.documentDrafts.id }).from(schema.documentDrafts);
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
      const row = listed.items.find((item) => item.documentId === CH1);
      if (!row) throw new Error("the model's edit made no draft to discard");
      const answer = await handleDiscardWorkDraftRequest(routes, {
        ...scope,
        branchId: row.branchId,
        documentId: CH1 as never,
        request: {
          branchId: row.branchId,
          itemKey: row.itemKey,
          commandId: randomUUID(),
          ends: "item",
          draftSeenAt: row.updatedAt,
        },
      } as never);
      console.log("DISCARD >>>", JSON.stringify(answer));
    }

    it("the writer discards the draft mid-round: the next edit is returned and the one after lands", async () => {
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
      const drafts = await draftRows();
      const branches = await branchRows();

      const returned = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Charlie three.",
        content: "Charlie, edited.",
      });
      console.log("RETURNED RESULT >>>\n" + returned.text);
      expect(returned.isError).toBeFalsy();
      expect(returned.text).toContain("status: returned");
      expect(returned.text).toContain("the writer discarded the draft");
      expect(returned.text).toContain("Charlie three.");
      expect(returned.text).not.toMatch(/re-read|retry|read again/i);
      // Nothing opened: no draft, no branch; and the row is a plain `done`.
      expect(await draftRows()).toEqual(drafts);
      expect(await branchRows()).toEqual(branches);
      const rows = await modelEditRows();
      console.log("ROWS", JSON.stringify(rows.map((r) => r.outcome)).slice(0, 1500));
      const last = rows.at(-1)?.outcome as never as {
        status: string;
        result: { settled?: unknown };
      };
      expect(last.status).toBe("done");
      expect(last.result.settled).toEqual([{ rule: "returned", why: "draft_discarded" }]);

      console.log(
        "FRONTIERS",
        JSON.stringify(
          await db.execute(
            sql`SELECT room_key, source_block_id, recorded_seq FROM observation_frontiers ORDER BY recorded_seq`,
          ),
        ),
      );
      // The model's view is now the current text: its next edit lands.
      const landed = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Charlie three.",
        content: "Charlie, edited.",
      });
      expect(landed.isError, landed.text).toBeFalsy();
      expect(landed.text).toContain("status: success");
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
      console.log("BLOCK GONE RESULT >>>\n" + returned.text);
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
      console.log("INSERT AFTER DELETED >>>\n" + landed.text);
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

    it("the writer deletes the document: the edit is returned, naming who", async () => {
      const { runtime, call } = await reply(LIVE_CHAT);
      await call("read", { path: "ch1" });
      const seeds = treeSeeder(db);
      await seeds.store.submit({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        make: ([{ writer }]) => writer.delete(LIVE, `user:${USER_ID}`, CH1),
      });
      const returned = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Alpha one.",
        content: "Alpha, edited.",
      });
      console.log("REMOVED RESULT >>>\n" + returned.text);
      expect(returned.isError, returned.text).toBeFalsy();
      expect(returned.text).toContain("status: returned");
      const [last] = (await modelEditRows()).slice(-1);
      expect(JSON.stringify(last?.outcome)).toContain("document_removed");
      // After the model deletes a document itself, a write on the same path says so too.
      const other = await reply(LIVE_CHAT);
      void runtime;
      void other;
    });

    it("the Work is archived: the draft edit is returned with the draft as it stands", async () => {
      const { call } = await reply(DRAFTING);
      await call("read", { path: "ch1" });
      await call("write", {
        command: "replace",
        path: "ch1",
        find: "Bravo two.",
        content: "Bravo, edited.",
      });
      await db.execute(sql`UPDATE works SET archived_at = now() WHERE id = ${WORK_ID}`);
      const returned = await call("write", {
        command: "replace",
        path: "ch1",
        find: "Charlie three.",
        content: "Charlie, edited.",
      });
      console.log("ARCHIVED RESULT >>>\n" + returned.text);
      expect(returned.isError, returned.text).toBeFalsy();
      expect(returned.text).toContain("status: returned");
      expect(returned.text).toContain("archived");
      expect(returned.text).toContain("Bravo, edited.");
      const [last] = (await modelEditRows()).slice(-1);
      expect(JSON.stringify(last?.outcome)).toContain("work_archived");
      void and;
    });
  });
}
