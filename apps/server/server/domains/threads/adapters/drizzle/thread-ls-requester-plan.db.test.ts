/** Query-plan gate for thread_ls's bounded latest-requester batch. */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-0000000007b1" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-0000000007b2" as ProjectId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread_ls requester plan (postgres)", () => {});
} else {
  describe("thread_ls requester plan (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { sql } = await import("drizzle-orm");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../../../test-support/drizzle-reset.js");
    const { latestLocalRequesterTextSql } = await import("./turn-repository.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 2 });
    const threadIds = Array.from({ length: 51 }, () => crypto.randomUUID() as ThreadId);

    beforeAll(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-ls-plan"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread ls plan",
        slug: "thread-ls-plan",
      });
      await db.insert(schema.threads).values(
        threadIds.map((id) => ({
          id,
          rootThreadId: id,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
        })),
      );
      for (const threadId of threadIds) {
        const turnIds = Array.from({ length: 100 }, () => crypto.randomUUID() as TurnId);
        await db.insert(schema.turns).values(
          turnIds.map((id, index) => ({
            id,
            threadId,
            parentTurnId: index === 0 ? null : turnIds[index - 1],
            position: index + 1,
            role: index % 2 === 0 ? "user" : "assistant",
            origin: index % 2 === 0 ? "writer" : "assistant",
            status: "complete",
          })) as never,
        );
        await db.insert(schema.turnBlocks).values({
          id: crypto.randomUUID(),
          turnId: turnIds[98] as TurnId,
          blockType: "text",
          sequence: 0,
          modelText: `latest request for ${threadId}`,
        });
      }
      await db.execute(sql`ANALYZE turns`);
      await db.execute(sql`ANALYZE turn_blocks`);
    });

    afterAll(async () => {
      await db.close();
    });

    it("uses one bounded backward index lookup per listed row", async () => {
      const query = latestLocalRequesterTextSql(threadIds);
      const explained = await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
      const [row] = Array.from(explained as unknown as Iterable<Record<string, unknown>>);
      const result = row?.["QUERY PLAN"];
      const root = Array.isArray(result)
        ? (result[0] as { Plan?: Record<string, unknown> })?.Plan
        : null;
      if (!root) throw new Error("EXPLAIN did not return a JSON plan");
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        if (Array.isArray(node.Plans)) {
          for (const child of node.Plans) visit(child as Record<string, unknown>);
        }
      };
      visit(root);
      if (process.env.REPORT_THREAD_LS_EXPLAIN === "1") {
        console.info(`thread_ls requester EXPLAIN: ${JSON.stringify(root)}`);
      }
      expect(
        nodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "turns"),
      ).toBe(false);
      expect(JSON.stringify(root)).toContain("turns_thread_position_unique");
      expect(Array.from((await db.execute(query)) as unknown as Iterable<unknown>)).toHaveLength(
        51,
      );
    });
  });
}
