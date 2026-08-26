/** PostgreSQL contract for bounded Work association projection and keyset order. */
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-000000000901";
const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
const HISTORICAL_WORK_ID = "00000000-0000-4000-8000-000000000903";
const CURRENT_WORK_ID = "00000000-0000-4000-8000-000000000904";
const THREAD_HIGH = "00000000-0000-4000-8000-000000000906";
const THREAD_LOW = "00000000-0000-4000-8000-000000000905";
const UPDATED_AT = "2026-08-22T12:00:00.654321Z";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work chat feed repository (postgres)", () => {});
} else {
  describe("Work chat feed repository (postgres)", async () => {
    const { sql } = await import("drizzle-orm");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase } = await import(
      "../../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositories } = await import("./repositories.js");
    const { getWorkChatFeedPage } = await import("../../domain/work-chat-feed.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 1,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });

    beforeEach(async () => {
      const db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-feed"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Feed",
        slug: "work-feed",
      });
      await db.insert(schema.works).values([
        {
          id: HISTORICAL_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Historical Work",
          slug: "historical-work",
        },
        {
          id: CURRENT_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Current Work",
          slug: "current-work",
        },
      ]);
      for (const [threadId, title] of [
        [THREAD_HIGH, "High"],
        [THREAD_LOW, "Low"],
      ] as const) {
        await db.execute(sql`
          INSERT INTO threads (id, project_id, created_by_user_id, title, status, updated_at)
          VALUES (${threadId}::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid,
            ${title}, 'idle', ${UPDATED_AT}::timestamptz)
        `);
        await db.insert(schema.threadWorks).values([
          { threadId, workId: HISTORICAL_WORK_ID, projectId: PROJECT_ID, isPrimary: false },
          { threadId, workId: CURRENT_WORK_ID, projectId: PROJECT_ID, isPrimary: true },
        ]);
      }
      const turnId = "00000000-0000-4000-8000-000000000907";
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, role, status, created_at, completed_at)
        VALUES (${turnId}::uuid, ${THREAD_HIGH}::uuid, 'assistant', 'waiting_interrupt',
          '2026-08-22T11:00:00.123456Z', '2026-08-22T11:00:00.123456Z')
      `);
      await db.execute(
        sql`UPDATE threads SET active_leaf_turn_id = ${turnId}::uuid WHERE id = ${THREAD_HIGH}::uuid`,
      );
      await db.execute(sql`
        INSERT INTO turn_blocks (turn_id, block_type, sequence, model_text, content, pruned)
        VALUES (${turnId}::uuid, 'text', 0, '  truthful   preview ', '{}', false)
      `);
      await db.insert(schema.threadUserState).values({
        threadId: THREAD_HIGH,
        userId: USER_ID,
        isFavorite: true,
      });
    });

    it("projects current primary identity and state while paging historical membership", async () => {
      const repos = createDrizzleRepositories(database.current);
      const first = await repos.workChatFeed.queryPage({
        projectId: PROJECT_ID,
        workId: HISTORICAL_WORK_ID,
        userId: USER_ID,
        after: null,
        limit: 1,
      });
      expect(first).toMatchObject([
        {
          item: {
            id: THREAD_HIGH,
            work: { id: CURRENT_WORK_ID, title: "Current Work" },
            lastMessagePreview: "truthful preview",
            lastActivityAt: "2026-08-22T11:00:00.123456Z",
            attention: "actionRequired",
            isFavorite: true,
          },
          updatedAt: UPDATED_AT,
        },
      ]);
      const second = await repos.workChatFeed.queryPage({
        projectId: PROJECT_ID,
        workId: HISTORICAL_WORK_ID,
        userId: USER_ID,
        after: { sortAt: first[0]?.updatedAt ?? "", threadId: THREAD_HIGH },
        limit: 2,
      });
      expect(second.map(({ item }) => item.id)).toEqual([THREAD_LOW]);
      await database.current.execute(
        sql`UPDATE threads SET deleted_at = now() WHERE id = ${THREAD_LOW}::uuid`,
      );
      await expect(
        repos.workChatFeed.queryPage({
          projectId: PROJECT_ID,
          workId: HISTORICAL_WORK_ID,
          userId: USER_ID,
          after: null,
          limit: 5,
        }),
      ).resolves.toHaveLength(1);
    });

    it("keeps 100, 500, and 2,500-association pages and payloads bounded", async () => {
      const db = database.current;
      await db.execute(sql`
        INSERT INTO threads (id, project_id, created_by_user_id, title, status, updated_at)
        SELECT md5('work-feed-thread-' || g)::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid,
          'Chat ' || g, 'idle', '2026-08-01T00:00:00Z'::timestamptz + g * interval '1 microsecond'
        FROM generate_series(1, 2500) g
      `);
      await db.execute(sql`
        INSERT INTO thread_works (thread_id, work_id, project_id, is_primary)
        SELECT md5('work-feed-thread-' || g)::uuid, ${CURRENT_WORK_ID}::uuid,
          ${PROJECT_ID}::uuid, true FROM generate_series(1, 2500) g
      `);
      const measurements: Array<{ size: number; bytes: number; elapsedMs: number }> = [];
      for (const size of [100, 500, 2_500]) {
        const workId = `00000000-0000-4000-9000-${String(size).padStart(12, "0")}`;
        await db.execute(sql`
          INSERT INTO works (id, project_id, created_by_user_id, name, slug)
          VALUES (${workId}::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid,
            ${`Benchmark ${size}`}, ${`benchmark-${size}`})
        `);
        await db.execute(sql`
          INSERT INTO thread_works (thread_id, work_id, project_id, is_primary)
          SELECT md5('work-feed-thread-' || g)::uuid, ${workId}::uuid,
            ${PROJECT_ID}::uuid, false FROM generate_series(1, ${size}) g
        `);
        const startedAt = performance.now();
        const page = await getWorkChatFeedPage({
          repository: createDrizzleRepositories(db).workChatFeed,
          projectId: PROJECT_ID,
          workId,
          userId: USER_ID,
        });
        const elapsedMs = performance.now() - startedAt;
        const bytes = Buffer.byteLength(JSON.stringify(page));
        measurements.push({ size, bytes, elapsedMs });
        expect(page.items).toHaveLength(50);
        expect(page.nextCursor).not.toBeNull();
        expect(bytes).toBeLessThan(25_000);
        if (size === 2_500 && page.nextCursor) {
          const next = await getWorkChatFeedPage({
            repository: createDrizzleRepositories(db).workChatFeed,
            projectId: PROJECT_ID,
            workId,
            userId: USER_ID,
            cursor: page.nextCursor,
          });
          expect(new Set([...page.items, ...next.items].map(({ id }) => id)).size).toBe(100);
        }
      }
      console.info(
        measurements
          .map(
            ({ size, bytes, elapsedMs }) =>
              `work-feed-${size} bytes=${bytes} elapsed_ms=${elapsedMs.toFixed(1)}`,
          )
          .join("\n"),
      );
    });
  });
}
