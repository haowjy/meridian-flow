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
    const { getHomeChatFeedPage } = await import("../../domain/home-feed.js");
    const { buildThreadSnapshot } = await import("../../thread-snapshot.js");

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
      await db.execute(
        sql`UPDATE turns SET status = 'waiting_interrupt' WHERE id = ${assistantId}::uuid`,
      );
      await repos.threadUserState.update({ threadId, userId: USER_ID, isUnread: true });
      const actionHome = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(actionHome.continueChat?.attention).toBe("actionRequired");
      expect(await repos.threadUserState.effectiveAttention(threadId, USER_ID)).toBe(
        "actionRequired",
      );
      expect((await repos.threads.listByProject(PROJECT_ID))[0]?.attention).toBe("actionRequired");
      await db.execute(sql`UPDATE turns SET status = 'complete' WHERE id = ${assistantId}::uuid`);
      await repos.threadUserState.update({ threadId, userId: USER_ID, isUnread: false });
      expect(await repos.threadUserState.effectiveAttention(threadId, USER_ID)).toBe("none");
      expect((await repos.threads.listByProject(PROJECT_ID))[0]?.attention).toBe("none");
      await repos.threadUserState.update({ threadId, userId: USER_ID, isUnread: true });
      const manualHome = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(manualHome.continueChat?.attention).toBe("unread");
      expect(await repos.threadUserState.effectiveAttention(threadId, USER_ID)).toBe("unread");
      expect((await repos.threads.listByProject(PROJECT_ID))[0]?.attention).toBe("unread");
      const snapshot = await buildThreadSnapshot(
        repos,
        { headSeq: async () => 0n, readModelProjectionWatermark: async () => 0n } as never,
        { getRunningTurnId: () => null },
        threadId,
        USER_ID,
      );
      expect(snapshot.attention).toBe("unread");
    });

    it("paginates equal microsecond activity across four pages with featured exclusivity", async () => {
      const db = database.current;
      await db.execute(sql`
        INSERT INTO threads (id, project_id, created_by_user_id, title, status)
        SELECT md5('equal-thread-' || g)::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid,
          'Equal ' || g, 'idle' FROM generate_series(1, 76) g
      `);
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, role, status, created_at, completed_at)
        SELECT md5('equal-turn-' || g)::uuid, md5('equal-thread-' || g)::uuid,
          'assistant', 'complete', '2026-08-13T12:00:00.123456Z', '2026-08-13T12:00:00.123456Z'
        FROM generate_series(1, 76) g
      `);
      await db.execute(sql`
        UPDATE threads t SET active_leaf_turn_id = md5(replace(t.title, 'Equal ', 'equal-turn-'))::uuid
        WHERE t.project_id = ${PROJECT_ID}::uuid
      `);
      const repos = createDrizzleRepositories(db);
      const favoriteIds = ["md5-placeholder"];
      const [favorite] = await db.execute(sql`SELECT md5('equal-thread-75')::uuid::text AS id`);
      if (!favorite) throw new Error("missing favorite");
      favoriteIds[0] = (favorite as { id: string }).id;
      const favoriteId = favoriteIds[0];
      if (!favoriteId) throw new Error("missing favorite id");
      await repos.threadUserState.update({
        threadId: favoriteId,
        userId: USER_ID,
        isFavorite: true,
      });

      const ids: string[] = [];
      let cursor: string | null | undefined;
      let pageNumber = 0;
      do {
        const page = await getHomeChatFeedPage({
          repository: repos.homeFeed,
          projectId: PROJECT_ID,
          userId: USER_ID,
          cursor,
        });
        if (pageNumber === 0) {
          ids.push(page.featured?.continueChat?.id ?? "");
          ids.push(...(page.featured?.favoriteChats.map((item) => item.id) ?? []));
          expect(page.featured?.favoriteChats).toHaveLength(1);
        } else {
          expect(page.featured).toBeNull();
        }
        ids.push(...page.recentChats.items.map((item) => item.id));
        cursor = page.recentChats.nextCursor;
        pageNumber += 1;
      } while (cursor);

      expect(pageNumber).toBe(4);
      expect(ids).toHaveLength(76);
      expect(new Set(ids).size).toBe(76);
      expect(ids.filter((id) => id === favoriteIds[0])).toHaveLength(1);
    });

    it("follows only the active lineage and owns preview filtering, order, blank, and cap", async () => {
      const db = database.current;
      const threadId = "00000000-0000-4000-8000-000000000520";
      const rootId = "00000000-0000-4000-8000-000000000521";
      const activeId = "00000000-0000-4000-8000-000000000522";
      const abandonedId = "00000000-0000-4000-8000-000000000523";
      await db.execute(sql`
        INSERT INTO threads (id, project_id, created_by_user_id, title, status)
        VALUES (${threadId}::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid, 'Lineage', 'idle')
      `);
      await db.execute(sql`
        INSERT INTO turns (id, thread_id, parent_turn_id, role, status, created_at, completed_at) VALUES
          (${rootId}::uuid, ${threadId}::uuid, NULL, 'user', 'complete', '2026-08-13T09:00:00Z', '2026-08-13T09:00:00Z'),
          (${activeId}::uuid, ${threadId}::uuid, ${rootId}::uuid, 'assistant', 'complete', '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z'),
          (${abandonedId}::uuid, ${threadId}::uuid, ${rootId}::uuid, 'assistant', 'complete', '2026-08-13T11:00:00Z', '2026-08-13T11:00:00Z')
      `);
      await db.execute(
        sql`UPDATE threads SET active_leaf_turn_id = ${activeId}::uuid WHERE id = ${threadId}::uuid`,
      );
      await db.execute(sql`
        INSERT INTO turn_blocks (turn_id, block_type, sequence, model_text, content, pruned) VALUES
          (${activeId}::uuid, 'text', 4, repeat('z', 250), '{}', false),
          (${activeId}::uuid, 'reasoning', 1, 'hidden reasoning', '{}', false),
          (${activeId}::uuid, 'text', 0, ' first ', '{}', false),
          (${activeId}::uuid, 'text', 2, 'pruned', '{}', true),
          (${activeId}::uuid, 'text', 3, E'  second\\n', '{}', false),
          (${abandonedId}::uuid, 'text', 0, 'abandoned', '{}', false)
      `);
      const repos = createDrizzleRepositories(db);
      const page = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(page.continueChat).toMatchObject({ lastActivityAt: "2026-08-13T10:00:00.000000Z" });
      expect(page.continueChat?.lastMessagePreview).toHaveLength(240);
      expect(page.continueChat?.lastMessagePreview?.startsWith("first second z")).toBe(true);
      expect(page.continueChat?.lastMessagePreview).not.toContain("reasoning");
      expect(page.continueChat?.lastMessagePreview).not.toContain("pruned");

      await db.execute(
        sql`UPDATE turn_blocks SET model_text = '   ' WHERE turn_id = ${activeId}::uuid AND block_type = 'text'`,
      );
      const blank = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(blank.continueChat?.lastMessagePreview).toBeNull();
    });

    it("keeps empty chats, archived Work labels, deleted Work nulls, and secondary membership singular", async () => {
      const db = database.current;
      const threadId = "00000000-0000-4000-8000-000000000530";
      await db.execute(sql`
        INSERT INTO works (id, project_id, created_by_user_id, name, slug, status) VALUES
          ('00000000-0000-4000-8000-000000000531', ${PROJECT_ID}::uuid, ${USER_ID}::uuid, 'Archived', 'archived', 'archived'),
          ('00000000-0000-4000-8000-000000000532', ${PROJECT_ID}::uuid, ${USER_ID}::uuid, 'Secondary', 'secondary', 'active')
      `);
      await db.execute(sql`
        INSERT INTO threads (id, project_id, created_by_user_id, title, status)
        VALUES (${threadId}::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid, 'Empty', 'idle')
      `);
      await db.execute(sql`
        INSERT INTO thread_works (thread_id, work_id, project_id, is_primary) VALUES
          (${threadId}::uuid, '00000000-0000-4000-8000-000000000531', ${PROJECT_ID}::uuid, true),
          (${threadId}::uuid, '00000000-0000-4000-8000-000000000532', ${PROJECT_ID}::uuid, false)
      `);
      const repos = createDrizzleRepositories(db);
      const archived = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(archived.continueChat).toMatchObject({
        lastMessagePreview: null,
        work: { title: "Archived" },
      });
      expect([archived.continueChat, ...archived.favorites, ...archived.recent]).toHaveLength(1);
      await repos.threadUserState.update({ threadId, userId: USER_ID, isUnread: true });
      const archivedWorkList = await repos.threads.listByWork(
        PROJECT_ID,
        "00000000-0000-4000-8000-000000000531",
      );
      const secondaryWorkList = await repos.threads.listByWork(
        PROJECT_ID,
        "00000000-0000-4000-8000-000000000532",
      );
      expect(archivedWorkList).toHaveLength(1);
      expect(secondaryWorkList).toHaveLength(1);
      expect(archivedWorkList[0]?.attention).toBe("unread");
      expect(secondaryWorkList[0]?.attention).toBe("unread");

      await db.execute(
        sql`UPDATE works SET deleted_at = clock_timestamp() WHERE id = '00000000-0000-4000-8000-000000000531'`,
      );
      const deleted = await repos.homeFeed.queryPage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        after: null,
        recentLimit: 25,
        includeFeatured: true,
      });
      expect(deleted.continueChat?.work).toBeNull();
    });

    it("uses DB time for monotonic partial combined and concurrent per-writer state", async () => {
      const db = database.current;
      const repos = createDrizzleRepositories(db);
      const threadId = "00000000-0000-4000-8000-000000000540";
      await db.execute(
        sql`INSERT INTO threads (id, project_id, created_by_user_id, title, status) VALUES (${threadId}::uuid, ${PROJECT_ID}::uuid, ${USER_ID}::uuid, 'State', 'idle')`,
      );
      const [clockBefore] = await db.execute(sql`SELECT clock_timestamp() AS now`);
      const first = await repos.threadUserState.update({
        threadId,
        userId: USER_ID,
        isFavorite: true,
        isUnread: false,
      });
      const [clockAfter] = await db.execute(sql`SELECT clock_timestamp() AS now`);
      if (!first.lastOpenedAt) throw new Error("read mutation did not return lastOpenedAt");
      expect(new Date(first.lastOpenedAt).getTime()).toBeGreaterThanOrEqual(
        new Date((clockBefore as { now: string }).now).getTime(),
      );
      expect(new Date(first.lastOpenedAt).getTime()).toBeLessThanOrEqual(
        new Date((clockAfter as { now: string }).now).getTime(),
      );

      const [unread, favorite] = await Promise.all([
        repos.threadUserState.update({ threadId, userId: USER_ID, isUnread: true }),
        repos.threadUserState.update({ threadId, userId: USER_ID, isFavorite: false }),
      ]);
      const owner = await repos.threadUserState.get(threadId, USER_ID);
      expect(owner).toMatchObject({ isFavorite: false, manuallyUnread: true });
      expect(owner.lastOpenedAt).toBe(first.lastOpenedAt);
      expect([unread.attention, favorite.attention]).toContain("unread");

      await repos.threadUserState.update({ threadId, userId: OTHER_USER_ID, isFavorite: true });
      expect(await repos.threadUserState.get(threadId, OTHER_USER_ID)).toMatchObject({
        isFavorite: true,
        manuallyUnread: false,
      });
      expect(await repos.threadUserState.get(threadId, USER_ID)).toMatchObject({
        isFavorite: false,
        manuallyUnread: true,
      });
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
