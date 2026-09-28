/** PostgreSQL index-plan and bounded-page contract over a large transcript. */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-0000000006b1" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-0000000006b2" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-0000000006b3" as ThreadId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("transcript reader (postgres)", () => {});
} else {
  describe("transcript reader (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { sql } = await import("drizzle-orm");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const { transcriptItemKeysSql } = await import("./transcript-reader.js");
    const { readTranscriptPage } = await import("../../domain/transcript-page.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const ids: TurnId[] = [];

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "transcript-plan"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Transcript plan",
        slug: "transcript-plan",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
      });
      ids.length = 0;
      for (let index = 0; index < 5000; index++) ids.push(crypto.randomUUID() as TurnId);
      for (let start = 0; start < ids.length; start += 400) {
        const batch = ids.slice(start, start + 400).map((id, offset) => {
          const index = start + offset;
          return {
            id,
            threadId: THREAD_ID,
            parentTurnId: index === 0 ? null : ids[index - 1],
            position: index + 1,
            role: index % 2 === 0 ? "user" : "assistant",
            origin: index % 2 === 0 ? "writer" : "assistant",
            status: "complete",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCostUsd: "0",
            responseCount: 0,
          };
        });
        await db.insert(schema.turns).values(batch as never);
      }
      await db.insert(schema.turnBlocks).values(
        Array.from({ length: 500 }, (_, sequence) => ({
          id: crypto.randomUUID(),
          turnId: ids[0] as TurnId,
          blockType: "text",
          sequence,
          modelText: `block ${sequence}`,
          content: { text: `block ${sequence}` },
        })) as never,
      );
      await db.execute(sql`ANALYZE turns`);
      await db.execute(sql`ANALYZE turn_blocks`);
    });

    afterAll(async () => {
      await db.close();
    });

    it.each([
      "newest_first",
      "oldest_first",
    ] as const)("uses bounded unique-index plans for %s reads on 5,000 turns and 500 blocks", async (order) => {
      const query = transcriptItemKeysSql({
        spans: [{ threadId: THREAD_ID, afterPosition: 0, throughPosition: 5000 }],
        order,
        unit: "item",
        limit: 20,
        through: { position: 5000, sequence: 499 },
      });
      const explained = await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
      const [row] = Array.from(explained as unknown as Iterable<Record<string, unknown>>);
      const explain = row?.["QUERY PLAN"];
      const root = Array.isArray(explain)
        ? (explain[0] as { Plan?: Record<string, unknown> })?.Plan
        : null;
      if (!root) throw new Error("EXPLAIN did not return a JSON plan");
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        const children = node.Plans;
        if (Array.isArray(children)) {
          for (const child of children) visit(child as Record<string, unknown>);
        }
      };
      visit(root);
      if (process.env.REPORT_TRANSCRIPT_EXPLAIN === "1") {
        console.info(`transcript EXPLAIN ${order}: ${JSON.stringify(root)}`);
      }
      const planText = JSON.stringify(root);
      expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
      expect(planText).toContain("turns_thread_position_unique");
      expect(planText).toContain("turn_blocks_turn_sequence");
      const output = await readTranscriptPage(
        repos,
        (await repos.threads.findById(THREAD_ID)) as never,
        {
          order,
          unit: "item",
          limit: 3,
        },
      );
      expect(output.entries.length).toBeGreaterThan(0);
      if (order === "oldest_first") {
        expect(output.entries[0]?.blocks).toHaveLength(3);
      }
    });
  });
}
