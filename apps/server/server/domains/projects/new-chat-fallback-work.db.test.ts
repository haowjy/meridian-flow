/** PostgreSQL truth for omitted-New-Chat fallback ordering, repair, and CAS contention. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("new-chat fallback (postgres)", () => {});
} else {
  describe("new-chat fallback (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues, assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq } = await import("drizzle-orm");
    const { createDrizzleProjectPreferencesRepository } = await import("../preferences/index.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleProjectWorkRepository } = await import("./index.js");
    const { resolveNewChatFallbackWork } = await import("./new-chat-fallback-work.js");

    const USER_ID = "00000000-0000-4000-8000-000000000961";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000962";
    const ACTIVE_OLDER = "00000000-0000-4000-8000-000000000963";
    const ACTIVE_NEWER = "00000000-0000-4000-8000-000000000964";
    const ARCHIVED = "00000000-0000-4000-8000-000000000965";
    const db = createDb(DATABASE_URL, { max: 6 });
    const project = { id: PROJECT_ID, userId: USER_ID, name: "Fallback Book" } as const;

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);

    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });
    const preferences = createDrizzleProjectPreferencesRepository({ db });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "fallback-postgres"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: project.name,
        slug: "fallback-book",
      });
      await db.insert(schema.works).values([
        {
          id: ACTIVE_OLDER,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Active older",
          slug: "active-older",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: ACTIVE_NEWER,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Active newer",
          slug: "active-newer",
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: ARCHIVED,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Archived",
          slug: "archived",
          status: "archived",
          archivedAt: new Date("2026-01-03T00:00:00.000Z"),
          updatedAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      ]);
    });

    afterAll(() => db.close());

    async function saveFallback(workId: string) {
      await db.insert(schema.projectUserPreferences).values({
        userId: USER_ID,
        projectId: PROJECT_ID,
        newChatFallbackWorkId: workId,
      });
    }

    it("keeps a saved archived fallback", async () => {
      await saveFallback(ARCHIVED);
      await expect(
        resolveNewChatFallbackWork({ works, preferences }, { userId: USER_ID }, project as never),
      ).resolves.toMatchObject({ id: ARCHIVED, status: "archived" });
    });

    it("repairs a soft-deleted dangling fallback to the newest active Work", async () => {
      await saveFallback(ARCHIVED);
      await db
        .update(schema.works)
        .set({ deletedAt: new Date() })
        .where(eq(schema.works.id, ARCHIVED));

      await expect(
        resolveNewChatFallbackWork({ works, preferences }, { userId: USER_ID }, project as never),
      ).resolves.toMatchObject({ id: ACTIVE_NEWER, status: "active" });
      await expect(preferences.getNewChatFallbackWorkId(USER_ID, PROJECT_ID)).resolves.toBe(
        ACTIVE_NEWER,
      );
    });

    it("uses the newest archived Work when no active Work remains", async () => {
      await db
        .update(schema.works)
        .set({ status: "archived", archivedAt: new Date() })
        .where(eq(schema.works.projectId, PROJECT_ID));

      await expect(
        resolveNewChatFallbackWork({ works, preferences }, { userId: USER_ID }, project as never),
      ).resolves.toMatchObject({ id: ARCHIVED, status: "archived" });
    });

    it("provisions and persists a concrete Work when none exists", async () => {
      await db.delete(schema.works).where(eq(schema.works.projectId, PROJECT_ID));

      const resolved = await resolveNewChatFallbackWork(
        { works, preferences },
        { userId: USER_ID },
        project as never,
      );

      expect(resolved).toMatchObject({ name: project.name, status: "active" });
      await expect(preferences.getNewChatFallbackWorkId(USER_ID, PROJECT_ID)).resolves.toBe(
        resolved.id,
      );
    });

    it("orders multiple active Works by update recency", async () => {
      await expect(
        resolveNewChatFallbackWork({ works, preferences }, { userId: USER_ID }, project as never),
      ).resolves.toMatchObject({ id: ACTIVE_NEWER });
      await expect(preferences.getNewChatFallbackWorkId(USER_ID, PROJECT_ID)).resolves.toBe(
        ACTIVE_NEWER,
      );
    });

    it("makes two resolvers race through the real CAS and makes the loser reread the winner", async () => {
      let waiting = 0;
      let release!: () => void;
      const bothReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      const outcomes: boolean[] = [];
      let reads = 0;
      const racingPreferences = {
        ...preferences,
        async getNewChatFallbackWorkId(userId: typeof USER_ID, projectId: typeof PROJECT_ID) {
          reads += 1;
          return preferences.getNewChatFallbackWorkId(userId, projectId);
        },
        async repairNewChatFallbackWorkId(
          userId: typeof USER_ID,
          projectId: typeof PROJECT_ID,
          expectedWorkId: null,
          workId: typeof ACTIVE_NEWER,
        ) {
          waiting += 1;
          if (waiting === 2) release();
          await bothReady;
          const result = await preferences.repairNewChatFallbackWorkId(
            userId,
            projectId,
            expectedWorkId,
            workId,
          );
          outcomes.push(result);
          return result;
        },
      };

      const [first, second] = await Promise.all([
        resolveNewChatFallbackWork(
          { works, preferences: racingPreferences },
          { userId: USER_ID },
          project as never,
        ),
        resolveNewChatFallbackWork(
          { works, preferences: racingPreferences },
          { userId: USER_ID },
          project as never,
        ),
      ]);

      expect([first.id, second.id]).toEqual([ACTIVE_NEWER, ACTIVE_NEWER]);
      expect(outcomes.sort()).toEqual([false, true]);
      expect(reads).toBe(3);
      await expect(preferences.getNewChatFallbackWorkId(USER_ID, PROJECT_ID)).resolves.toBe(
        ACTIVE_NEWER,
      );
    });
  });
}
