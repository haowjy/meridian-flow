/** PostgreSQL authority tests for Home lineage, exact cursors, state, and 1,000-chat scale. */
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-4000-8000-000000000501";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000502";
const PROJECT_ID = "00000000-0000-4000-8000-000000000503";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Home feed repository (postgres)", () => {});
} else {
  describe("Home feed repository (postgres)", async () => {
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

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 1,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });

    beforeEach(async () => {
      const db = database.current;
      await db
        .insert(schema.users)
        .values([
          conformanceUserValues(USER_ID, "home-feed"),
          conformanceUserValues(OTHER_USER_ID, "home-feed-other"),
        ]);
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Home Feed",
        slug: "home-feed",
      });
    });

    it("projects the visible lineage with microsecond activity and isolated writer state", async () => {
      const db = database.current;
      const repos = createDrizzleRepositories(db);
      const threadId = "00000000-0000-4000-8000-000000000510";
      const assistantId = "00000000-0000-4000-8000-000000000512";
      await db.execute(sql`
        INSERT INTO threads (id, project_id, created_by_user_id, title, status)
        VALUES (${threadId}::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid, 'Visible', 'idle')
      `);
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, role, status, created_at, completed_at)
        VALUES ('00000000-0000-4000-8000-000000000511', ${threadId}::uuid, 'user', 'complete',
          '2026-08-13T10:00:00.000001Z', '2026-08-13T10:00:00.000001Z')
      `);
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, parent_turn_id, role, status, created_at, completed_at)
        VALUES (${assistantId}::uuid, ${threadId}::uuid,
          '00000000-0000-4000-8000-000000000511', 'assistant', 'complete',
          '2026-08-13T10:01:00.123456Z', '2026-08-13T10:01:00.123456Z')
      `);
      await db.execute(sql`
        INSERT INTO turn_blocks (turn_id, block_type, sequence, model_text, content, pruned)
        VALUES (${assistantId}::uuid, 'text', 0, '  latest\n  prose  ', '{}', false),
          (${assistantId}::uuid, 'reasoning', 1, 'secret reasoning', '{}', false),
          (${assistantId}::uuid, 'text', 2, 'continued', '{}', false)
      `);
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, parent_turn_id, role, status, metadata, created_at, completed_at)
        VALUES ('00000000-0000-4000-8000-000000000513', ${threadId}::uuid, ${assistantId}::uuid,
          'user', 'complete', '{"kind":"system_update","section":"work_context"}',
          '2026-08-13T11:00:00.999999Z', '2026-08-13T11:00:00.999999Z')
      `);
      await db.execute(sql`
        UPDATE threads SET active_leaf_turn_id = '00000000-0000-4000-8000-000000000513'
        WHERE id = ${threadId}::uuid
      `);
      await repos.threadUserState.update({ threadId, userId: USER_ID, isFavorite: true });
      const owner = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(owner.continueChat).toMatchObject({
        lastActivityAt: "2026-08-13T10:01:00.123456Z",
        lastMessagePreview: "latest prose continued",
        isFavorite: true,
        attention: "unread",
      });
      const other = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: OTHER_USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(other.continueChat?.isFavorite).toBe(false);
      await repos.threadUserState.update({ threadId, userId: USER_ID, isUnread: false });
      expect(await repos.threadUserState.effectiveAttention(threadId, USER_ID)).toBe("none");
    });

    it("keeps a generated 1,000-chat initial read within the interactive budget", async () => {
      const db = database.current;
      await db.execute(sql`
        INSERT INTO threads (id, project_id, created_by_user_id, title, status, created_at)
        SELECT md5('home-thread-' || g)::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid,
          'Chat ' || g, 'idle', '2026-08-01T00:00:00Z'::timestamptz + g * interval '1 microsecond'
        FROM generate_series(1, 1000) g
      `);
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, role, status, created_at, completed_at)
        SELECT md5('home-turn-' || g)::uuid, md5('home-thread-' || g)::uuid,
          'assistant', 'complete',
          '2026-08-01T00:00:00Z'::timestamptz + g * interval '1 microsecond',
          '2026-08-01T00:00:00Z'::timestamptz + g * interval '1 microsecond'
        FROM generate_series(1, 1000) g
      `);
      await db.execute(sql`
        UPDATE threads t SET active_leaf_turn_id = md5('home-turn-' || substring(t.title from 6))::uuid
        WHERE t.project_id = ${PROJECT_ID}::uuid
      `);
      const repos = createDrizzleRepositories(db);
      const startedAt = performance.now();
      const page = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      const elapsedMs = performance.now() - startedAt;
      console.info(`home-feed-1000 elapsed_ms=${elapsedMs.toFixed(1)}`);
      expect(page.continueChat?.title).toBe("Chat 1000");
      expect(page.recent).toHaveLength(25);
      expect(elapsedMs).toBeLessThan(1_000);
    });
  });
}
