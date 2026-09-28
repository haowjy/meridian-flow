/** PostgreSQL half of the shared transcript reader behavior contract. */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("transcript page adapter contract (postgres)", () => {});
} else {
  describe("transcript page adapter contract (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase } = await import(
      "../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../adapters/drizzle/repositories.js"
    );
    const { defineTranscriptPageContract } = await import(
      "../__conformance__/transcript-page-contract.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
    const userId = "00000000-0000-4000-8000-000000000a01" as UserId;
    const projectId = "00000000-0000-4000-8000-000000000a02" as ProjectId;

    beforeEach(async () => {
      db = database.current;
      await db
        .insert(schema.users)
        .values(conformanceUserValues(userId, "transcript-page-contract"));
      await db.insert(schema.projects).values({
        id: projectId,
        userId,
        name: "Transcript page contract",
        slug: "transcript-page-contract",
      });
    });

    it("keeps a refused manual compaction in segment zero and opens segment one only on completion", async () => {
      const { readTranscriptPage } = await import("./transcript-page.js");
      const repos = createDrizzleRepositoriesForTest(db);
      const thread = await repos.threads.create({ projectId, userId });
      const threadId = thread.id as ThreadId;
      const initial = await repos.threads.bakeInitialPrompt(threadId, {
        composedSystemPrompt: "initial prompt",
        bakedSkillSlugs: [],
        bakedTools: [],
        contentHash: "manual-control-initial",
      });
      const controls = await db
        .insert(schema.threadInboxMessages)
        .values(
          ["refused", "completed", "queued"].map((idempotencyKey) => ({
            threadId,
            intent: "control",
            provenance: { kind: "writer", actorId: userId },
            body: { kind: "compact" },
            idempotencyKey,
            deliveredAt: idempotencyKey === "queued" ? null : new Date(),
          })),
        )
        .returning();
      const refused = await repos.turns.create({
        threadId,
        role: "compaction",
        origin: "system",
        status: "error",
        metadata: {
          trigger: "manual",
          controlMessageId: controls[0].id,
          reason: "nothing_to_compact",
        },
      });
      const writer = await repos.turns.create({
        threadId,
        prevTurnId: refused.id as TurnId,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      const bake = await repos.promptBakes.create({
        ownerThreadId: threadId,
        composedSystemPrompt: "manual compaction prompt",
        bakedSkillSlugs: [],
        bakedTools: [],
        contentHash: "manual-control-complete",
      });
      const compactedThrough = { turnId: refused.id };
      const completed = await repos.turns.create({
        threadId,
        prevTurnId: writer.id as TurnId,
        role: "compaction",
        origin: "system",
        status: "complete",
        promptBakeId: bake.id,
        compactionModel: "contract-compaction-model",
        metadata: {
          trigger: "manual",
          controlMessageId: controls[1].id,
          compactedThrough,
          pinnedRequestTurnIds: [writer.id],
        },
      });
      for (const order of ["oldest_first", "newest_first"] as const) {
        const pages = [];
        let cursor: string | undefined;
        do {
          const page = await readTranscriptPage(repos, thread, {
            order,
            unit: "turn",
            limit: 10,
            cursor,
          });
          pages.push(page);
          cursor = page.nextCursor;
        } while (cursor && pages.length < 4);
        const chronological = order === "oldest_first" ? pages : [...pages].reverse();
        expect(chronological.map((page) => page.segment.index)).toEqual([0, 1]);
        expect(chronological[0].segment).toMatchObject({ bakeId: initial.bake.id, openedBy: null });
        expect(chronological[0].entries.map((entry) => entry.turn.id)).toEqual([
          refused.id,
          writer.id,
        ]);
        expect(chronological[1].segment).toMatchObject({
          bakeId: bake.id,
          openedBy: { turnId: completed.id, kind: "compaction" },
          compactedThrough,
        });
        expect(chronological[1].entries.map((entry) => entry.turn.id)).toEqual([completed.id]);
        expect(pages.at(-1)?.hasMore).toBe(false);
        expect(pages.every((page) => page.unsettledTail === undefined)).toBe(true);
      }
    });

    defineTranscriptPageContract(async () => ({
      repos: createDrizzleRepositoriesForTest(db),
      projectId,
      userId,
    }));
  });
}
