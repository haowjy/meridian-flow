/**
 * Allowing a permission request runs the approved Work command in a savepoint
 * inside the answer transaction. A domain refusal discards the command's writes
 * and after-commit effects, then commits the answer with an error tool result;
 * an infrastructure failure rolls back the whole answer.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - durable permission requests execute in a savepoint of the answer transaction (kb/decisions/agents/tools/ask-settles-the-run.md)
 */

import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { projects, users, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("permission answer savepoint (postgres)", () => {});
} else {
  describe("permission answer savepoint (postgres)", () => {
    // The answer commits for real so after-commit effects run or are discarded.
    const db = createDb(DATABASE_URL, { max: 6 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);
    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
    });

    /**
     * An open request to rename the target to a taken name. Before the real
     * update runs, the Work adapter writes the target's goal and registers an
     * after-commit effect, then fails as `failure` says.
     */
    async function openRename(failure: "name_conflict" | "infrastructure") {
      const runtime = await runtimes.compose();
      const userId = randomUUID();
      const projectId = randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, "permission-answer"));
      await db.insert(projects).values({ id: projectId, userId, name: "Asks", slug: "asks" });
      const [target] = await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name: "Review target", handle: "w1" })
        .returning();
      await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name: "Already taken", handle: "w2" });
      if (!target) throw new Error("Work fixture was not created");
      const executionId = randomUUID();
      const repos = runtime.ports.threadRepos;
      const thread = await repos.threads.create({ aiWriteMode: "direct", projectId, userId });
      const turn = await repos.turns.create({
        threadId: thread.id,
        role: "assistant",
        origin: "assistant",
        status: "awaiting_answer",
        executionId,
      });
      const ask = await repos.asks.create({
        threadId: thread.id,
        askingTurnId: turn.id,
        executionId,
        toolCallId: "work-call",
        kind: "permission",
        payload: {
          agent: null,
          action: "work.update",
          work: { handle: "w1", name: "Review target" },
          changes: { name: "Already taken" },
        },
        permissionCommand: { command: "update", workId: target.id, name: "Already taken" },
        deadlineAt: null,
        status: "open",
        resolution: null,
        submissionId: null,
      });

      const effects: string[] = [];
      const workRepo = runtime.ports.workRepo;
      const update = workRepo.update;
      workRepo.update = async (id, input) => {
        await currentDrizzleDb(db)
          .update(works)
          .set({ goal: "partial write" })
          .where(eq(works.id, target.id));
        deferUntilDrizzleCommit(() => {
          effects.push("partial effect");
        });
        if (failure === "infrastructure") throw new Error("database disconnected");
        return update(id, input);
      };

      const answer = () =>
        runtime.app.asks.answer({
          userId,
          threadId: thread.id,
          askId: ask.id,
          submissionId: "allow",
          answer: { kind: "allow" },
        });
      const state = async () => ({
        ask: await repos.asks.findById(ask.id),
        blocks: await repos.blocks.listByTurn(turn.id),
        target: (await db.select().from(works).where(eq(works.id, target.id)))[0],
        effects,
      });
      return { answer, state };
    }

    it("commits a refused action as an error result and discards its writes and effects", async () => {
      const rig = await openRename("name_conflict");

      await expect(rig.answer()).resolves.toMatchObject({
        ok: true,
        ask: { status: "answered", resolution: { kind: "allow" } },
      });

      const after = await rig.state();
      expect(after.ask).toMatchObject({ status: "answered", resolution: { kind: "allow" } });
      expect(after.blocks).toEqual([
        expect.objectContaining({
          blockType: "tool_result",
          content: expect.objectContaining({ isError: true }),
        }),
      ]);
      expect(JSON.stringify(after.blocks[0]?.content)).toContain("work_name_conflict");
      expect(after.target).toMatchObject({ name: "Review target", goal: null });
      expect(after.effects).toEqual([]);
    });

    it("rolls back the whole answer when the action's infrastructure fails", async () => {
      const rig = await openRename("infrastructure");

      await expect(rig.answer()).rejects.toThrow("database disconnected");

      const after = await rig.state();
      expect(after.ask).toMatchObject({ status: "open", resolution: null });
      expect(after.blocks).toEqual([]);
      expect(after.target).toMatchObject({ name: "Review target", goal: null });
      expect(after.effects).toEqual([]);
    });
  });
}
