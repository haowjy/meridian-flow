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
    const { transcriptBoundariesSql, transcriptItemKeysSql, transcriptUnsettledTurnsSql } =
      await import("./transcript-reader.js");
    const { readTranscriptPage } = await import("../../domain/transcript-page.js");
    const { createDrizzleThreadLock } = await import(
      "../../../runtime/adapters/drizzle-thread-lock.js"
    );
    const { createDrizzleInbox } = await import("../../../runtime/adapters/drizzle-inbox.js");
    const { createDrizzleEventJournalWriter } = await import("../../index.js");
    const { finalizeOrphanedTurns } = await import("../../../runtime/loop/orphaned-placeholder.js");

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
        rootThreadId: THREAD_ID,
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
      for (let start = 1; start < ids.length; start += 400) {
        await db.insert(schema.turnBlocks).values(
          ids.slice(start, start + 400).map((turnId, offset) => ({
            id: crypto.randomUUID(),
            turnId,
            blockType: "text",
            sequence: 0,
            modelText: `turn ${start + offset + 1}`,
            content: { text: `turn ${start + offset + 1}` },
          })) as never,
        );
      }
      await db.execute(sql`ANALYZE turns`);
      await db.execute(sql`ANALYZE turn_blocks`);
    });

    afterAll(async () => {
      await db.close();
    });

    async function explain(query: ReturnType<typeof transcriptItemKeysSql>) {
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
      return { root, nodes, text: JSON.stringify(root) };
    }

    it.each([
      "newest_first",
      "oldest_first",
    ] as const)("uses bounded unique-index plans for %s reads on 5,000 turns with a 500-block turn", async (order) => {
      const span = { threadId: THREAD_ID, afterPosition: 0, throughPosition: 5000 };
      const query = transcriptItemKeysSql({
        spans: [span],
        order,
        unit: "item",
        limit: 20,
        after: { position: 1, sequence: 249 },
        through: { position: 5000, sequence: 499 },
      });
      const plan = await explain(query);
      if (process.env.REPORT_TRANSCRIPT_EXPLAIN === "1") {
        console.info(`transcript EXPLAIN ${order} after cursor: ${JSON.stringify(plan.root)}`);
      }
      expect(
        plan.nodes.some(
          (node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "turns",
        ),
      ).toBe(false);
      expect(plan.text).toContain("turns_thread_position_unique");
      expect(plan.text).toContain("turn_blocks_turn_sequence");
      expect(
        plan.nodes.some(
          (node) =>
            typeof node["Index Cond"] === "string" &&
            node["Index Cond"].includes("sequence") &&
            node["Index Cond"].includes("CASE"),
        ),
      ).toBe(true);
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

    it("uses the unsettled and epoch-boundary partial indexes", async () => {
      const bake = await repos.promptBakes.create({
        ownerThreadId: THREAD_ID,
        composedSystemPrompt: "index plan bake",
        bakedSkillSlugs: [],
        bakedTools: [],
        contentHash: "index-plan-bake",
      });
      await db
        .update(schema.turns)
        .set({ promptBakeId: bake.id })
        .where(sql`${schema.turns.id} = ${ids.at(-1)}::uuid`);
      await db.insert(schema.turns).values({
        id: crypto.randomUUID(),
        threadId: THREAD_ID,
        parentTurnId: ids.at(-1),
        position: 5001,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: "0",
        responseCount: 0,
      } as never);
      await db.execute(sql`ANALYZE turns`);
      const spans = [{ threadId: THREAD_ID, afterPosition: 0, throughPosition: 5001 }];
      const unsettled = await explain(transcriptUnsettledTurnsSql(spans) as never);
      const boundaries = await explain(transcriptBoundariesSql(spans) as never);
      if (process.env.REPORT_TRANSCRIPT_EXPLAIN === "1") {
        console.info(`transcript EXPLAIN turns_unsettled: ${JSON.stringify(unsettled.root)}`);
        console.info(
          `transcript EXPLAIN turns_epoch_boundaries: ${JSON.stringify(boundaries.root)}`,
        );
      }
      expect(unsettled.text).toContain("turns_unsettled");
      expect(boundaries.text).toContain("turns_epoch_boundaries");
    });

    it("walks newest-first through the 500-block turn by item cursor", async () => {
      const thread = await repos.threads.findById(THREAD_ID);
      if (!thread) throw new Error("Transcript plan fixture thread missing");
      let cursor = Buffer.from(
        JSON.stringify({
          v: 1,
          t: THREAD_ID,
          o: "newest_first",
          u: "item",
          r: "effective",
          a: [1, 499],
          k: [2, -1],
        }),
      ).toString("base64url");
      const sequences: number[] = [];
      for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
        const page = await readTranscriptPage(repos, thread, {
          order: "newest_first",
          unit: "item",
          limit: 20,
          cursor,
        });
        sequences.push(
          ...page.entries.flatMap((entry) => entry.blocks.map((block) => block.sequence)),
        );
        if (!page.hasMore) break;
        if (!page.nextCursor) throw new Error("Newest-first page did not advance its cursor");
        cursor = page.nextCursor;
      }
      expect(sequences.sort((left, right) => right - left)).toEqual(
        Array.from({ length: 500 }, (_, index) => 499 - index),
      );
    });

    it("reads unsettled, anchor, boundary, and page rows from one repeatable-read snapshot", async () => {
      const insertedWriterId = crypto.randomUUID() as TurnId;
      const insertedUnsettledId = crypto.randomUUID() as TurnId;
      const bake = await repos.promptBakes.create({
        ownerThreadId: THREAD_ID,
        composedSystemPrompt: "concurrent bake",
        bakedSkillSlugs: [],
        bakedTools: [],
        contentHash: "concurrent-bake",
      });
      const thread = await repos.threads.findByIdIncludingDeleted(THREAD_ID);
      if (!thread) throw new Error("Snapshot fixture thread missing");

      const snapshotRepos = {
        ...repos,
        async readSnapshot<T>(operation: () => Promise<T>) {
          return repos.readSnapshot(async () => {
            // Establish the repeatable-read snapshot before the separate connection commits.
            await repos.threads.findByIdIncludingDeleted(THREAD_ID);
            await db.insert(schema.turns).values([
              {
                id: insertedWriterId,
                threadId: THREAD_ID,
                parentTurnId: ids.at(-1),
                position: 5001,
                role: "user",
                origin: "writer",
                status: "complete",
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCostUsd: "0",
                responseCount: 0,
              },
              {
                id: insertedUnsettledId,
                threadId: THREAD_ID,
                parentTurnId: insertedWriterId,
                position: 5002,
                role: "assistant",
                origin: "assistant",
                status: "streaming",
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCostUsd: "0",
                responseCount: 0,
              },
            ] as never);
            await db
              .update(schema.turns)
              .set({ promptBakeId: bake.id })
              .where(sql`${schema.turns.id} = ${ids.at(-1)}::uuid`);
            await db.insert(schema.turnBlocks).values({
              id: crypto.randomUUID(),
              turnId: insertedWriterId,
              blockType: "text",
              sequence: 0,
              modelText: "committed after snapshot",
              content: { text: "committed after snapshot" },
            } as never);
            return operation();
          });
        },
      };

      const page = await readTranscriptPage(snapshotRepos, thread, {
        order: "newest_first",
        unit: "item",
        limit: 3,
      });
      expect(page.entries.flatMap((entry) => entry.turn.id)).not.toContain(insertedWriterId);
      expect(page.unsettledTail).toBeUndefined();
      const cursor = JSON.parse(
        Buffer.from(page.nextCursor as string, "base64url").toString("utf8"),
      ) as {
        a: [number, number];
      };
      expect(cursor.a).toEqual([5000, 0]);
      expect(page.segment.index).toBe(0);
      expect(page.segmentBoundary).toBe(false);
    });

    it("orphan repair reads unsettled turns through its thread-lock transaction", async () => {
      const threadLock = createDrizzleThreadLock(db);
      await threadLock.withThreadLock(THREAD_ID, async () => {
        const pendingWriter = await repos.turns.create({
          threadId: THREAD_ID,
          prevTurnId: ids.at(-1),
          role: "user",
          origin: "writer",
          status: "pending",
        });
        const originalList = repos.turns.listUnsettledForThread.bind(repos.turns);
        const observedRepos = {
          ...repos,
          turns: {
            ...repos.turns,
            async listUnsettledForThread(threadId: ThreadId) {
              const unsettled = await originalList(threadId);
              expect(unsettled.map((turn) => turn.id)).toContain(pendingWriter.id);
              return unsettled;
            },
          },
        };
        await finalizeOrphanedTurns(
          {
            repos: observedRepos,
            inbox: createDrizzleInbox(db),
            eventWriter: createDrizzleEventJournalWriter(db),
          },
          { threadId: THREAD_ID },
        );
      });
    });
  });
}
