/** PostgreSQL guards and epoch-transition behavior for immutable prompt bakes. */

import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  THREAD_WORK_RACE as ids,
  resetThreadWorkRaceFixture,
} from "../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN || !DATABASE_URL) describe.skip("prompt bakes (postgres)", () => {});
else {
  assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
  describe("prompt bakes (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { createDrizzleRepositoriesForTest } = await import(
      "../adapters/drizzle/repositories.js"
    );
    const { createDrizzleEventJournalWriter } = await import("../adapters/drizzle/event-writer.js");
    const { createDrizzleEventJournalReader } = await import("../adapters/drizzle/event-reader.js");
    const { beginPromptEpoch } = await import("../../runtime/loop/begin-prompt-epoch.js");
    const { hashPromptBakeContent } = await import("./prompt-bake-hash.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const writer = createDrizzleEventJournalWriter(db);
    const reader = createDrizzleEventJournalReader(db);

    beforeEach(async () => resetThreadWorkRaceFixture(db));
    afterAll(() => db.close());

    function content(prompt: string) {
      const parts = {
        composedSystemPrompt: prompt,
        bakedSkillSlugs: [],
        bakedTools: [],
      };
      return { ...parts, contentHash: hashPromptBakeContent(parts) };
    }

    it("rejects bake updates/deletes and second writes to both pointers", async () => {
      const first = await repos.threads.bakeInitialPrompt(ids.threadId, content("first"));
      const second = await repos.promptBakes.create({
        ownerThreadId: ids.threadId,
        ...content("second"),
      });
      const turn = await repos.turns.create({
        threadId: ids.threadId,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await repos.turns.updateStatus(turn.id, {
        status: "complete",
        promptBakeId: first.bake.id,
      });

      await expect(
        db
          .update(schema.promptBakes)
          .set({ composedSystemPrompt: "changed" })
          .where(eq(schema.promptBakes.id, first.bake.id)),
      ).rejects.toMatchObject({ cause: { message: "Prompt bakes are insert-only" } });
      await expect(
        db.delete(schema.promptBakes).where(eq(schema.promptBakes.id, first.bake.id)),
      ).rejects.toMatchObject({ cause: { message: "Prompt bakes are insert-only" } });

      await expect(
        db
          .update(schema.threads)
          .set({ initialPromptBakeId: second.id })
          .where(eq(schema.threads.id, ids.threadId)),
      ).rejects.toMatchObject({ cause: { message: "Prompt bake pointer is write-once" } });
      await expect(
        db
          .update(schema.turns)
          .set({ promptBakeId: second.id })
          .where(eq(schema.turns.id, turn.id)),
      ).rejects.toMatchObject({ cause: { message: "Prompt bake pointer is write-once" } });

      await db
        .update(schema.threads)
        .set({ initialPromptBakeId: first.bake.id })
        .where(eq(schema.threads.id, ids.threadId));
      await db
        .update(schema.turns)
        .set({ promptBakeId: first.bake.id })
        .where(eq(schema.turns.id, turn.id));
      expect(await repos.threads.findById(ids.threadId)).toMatchObject({
        initialPromptBakeId: first.bake.id,
      });
      expect(await repos.turns.findById(turn.id)).toMatchObject({
        promptBakeId: first.bake.id,
      });
    });

    it("reuses identical current bytes while completing and journaling the boundary", async () => {
      const parts = {
        composedSystemPrompt: "unchanged bytes",
        bakedSkillSlugs: ["voice"],
        bakedTools: [{ type: "function", name: "write" }],
      };
      const first = await repos.threads.bakeInitialPrompt(ids.threadId, {
        ...parts,
        contentHash: hashPromptBakeContent(parts),
      });
      const boundary = await repos.turns.create({
        threadId: ids.threadId,
        role: "system",
        origin: "system",
        status: "pending",
      });
      const responseId = crypto.randomUUID();

      const result = await beginPromptEpoch(
        { repos, eventWriter: writer },
        {
          threadId: ids.threadId as never,
          cause: "compaction",
          bake: { compose: parts },
          boundaryTurnId: boundary.id,
          completion: {
            blocks: [],
            metadata: { kind: "compaction", compactedThrough: boundary.id },
            modelResponses: [
              {
                id: responseId,
                turnId: boundary.id,
                sequence: 0,
                provider: "test-provider",
                model: "summary-model",
                priceSource: "unknown",
                predictedCacheState: "warm",
                predictedCacheReason: "reusable_prefix",
              },
            ],
            events: [
              {
                type: "context.compacted",
                compactionTurnId: boundary.id,
                compactedThrough: { turnId: boundary.id },
                bakeId: first.bake.id,
                model: "summary-model",
                tokensBefore: 200,
                tokensAfter: 80,
              },
            ],
          },
        },
      );

      expect(result.bakeId).toBe(first.bake.id);
      expect(await repos.promptBakes.findById(result.bakeId)).toEqual(first.bake);
      expect(await repos.modelResponses.findById(responseId)).toMatchObject({
        predictedCacheState: "warm",
        predictedCacheReason: "reusable_prefix",
      });
      expect(await repos.turns.findById(boundary.id)).toMatchObject({
        status: "complete",
        promptBakeId: first.bake.id,
        metadata: {
          kind: "compaction",
          compactedThrough: boundary.id,
          promptEpoch: { cause: "compaction" },
        },
      });
      expect(await reader.listByType(ids.threadId as never, "context.compacted")).toHaveLength(1);
      const ownedRows = await db
        .select({ id: schema.promptBakes.id })
        .from(schema.promptBakes)
        .where(eq(schema.promptBakes.ownerThreadId, ids.threadId));
      expect(ownedRows).toHaveLength(1);
    });

    it("cascades account deletion through bake owners and cross-thread references", async () => {
      const source = await repos.threads.bakeInitialPrompt(ids.threadId, content("source"));
      const fork = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Reference holder",
      });
      await db
        .update(schema.threads)
        .set({ initialPromptBakeId: source.bake.id })
        .where(eq(schema.threads.id, fork.id));
      await db.delete(schema.documentBranches).where(eq(schema.documentBranches.id, ids.branchId));

      await db.delete(schema.users).where(eq(schema.users.id, ids.userId));

      expect(await db.select({ id: schema.promptBakes.id }).from(schema.promptBakes)).toEqual([]);
      expect(await db.select({ id: schema.users.id }).from(schema.users)).toEqual([]);
    });
  });
}
