/** Real-Postgres regression for the multi-Work collection route (#452). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const { requireAppUser } = vi.hoisted(() => ({ requireAppUser: vi.fn() }));

vi.mock("../../../../../lib/auth-gate.js", () => ({ requireAppUser }));

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("GET Work collection (postgres)", () => {});
} else {
  describe("GET Work collection (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleProjectPreferencesRepository } = await import(
      "../../../../../domains/preferences/index.js"
    );
    const { createDrizzleProjectRepository, createDrizzleProjectWorkRepository } = await import(
      "../../../../../domains/projects/index.js"
    );
    const { useRollbackTestDatabase } = await import(
      "../../../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { default: handler } = await import("./index.get.js");

    const OWNER_ID = "00000000-0000-4000-8000-000000000951";
    const OTHER_USER_ID = "00000000-0000-4000-8000-000000000952";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000953";
    const OLDER_WORK_ID = "00000000-0000-4000-8000-000000000954";
    const NEWER_WORK_ID = "00000000-0000-4000-8000-000000000955";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let preferences: ReturnType<typeof createDrizzleProjectPreferencesRepository>;
    let routeApp: {
      projectRepo: ReturnType<typeof createDrizzleProjectRepository>;
      workRepo: ReturnType<typeof createDrizzleProjectWorkRepository>;
      preferences: typeof preferences;
      documentSync: { countUnpushedRowsForWork(workId: string): Promise<number> };
    };

    beforeEach(async () => {
      const db = database.current;
      requireAppUser.mockReset();
      await db
        .insert(schema.users)
        .values([
          conformanceUserValues(OWNER_ID, "works-route-owner"),
          conformanceUserValues(OTHER_USER_ID, "works-route-other"),
        ]);
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: OWNER_ID,
        name: "Two Works",
        slug: "two-works",
      });
      await db.insert(schema.works).values([
        {
          id: OLDER_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: OWNER_ID,
          name: "Older Work",
          slug: "older-work",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: NEWER_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: OWNER_ID,
          name: "Newer Work",
          slug: "newer-work",
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ]);

      preferences = createDrizzleProjectPreferencesRepository({ db });
      routeApp = {
        projectRepo: createDrizzleProjectRepository({ db }),
        workRepo: createDrizzleProjectWorkRepository({
          db,
          hasUnreviewedDraft: async () => false,
        }),
        preferences,
        documentSync: { countUnpushedRowsForWork: async () => 0 },
      };
      requireAppUser.mockResolvedValue({ user: { userId: OWNER_ID }, app: routeApp });
    });

    function event(status: "active" | "archived" | "all" = "all") {
      return {
        req: new Request(`https://server.local/api/projects/${PROJECT_ID}/works?status=${status}`),
        context: { params: { projectId: PROJECT_ID } },
        res: { status: 200 },
      };
    }

    it("returns both active Works without reading or repairing fallback preference", async () => {
      await expect(
        preferences.repairNewChatFallbackWorkId(OWNER_ID, PROJECT_ID, null, OLDER_WORK_ID),
      ).resolves.toBe(true);

      const response = await handler(event("all") as never);

      expect(response).toMatchObject({
        value: {
          works: [
            { id: NEWER_WORK_ID, status: "active" },
            { id: OLDER_WORK_ID, status: "active" },
          ],
        },
      });
      expect(Object.keys(response.value)).toEqual(["works"]);
      await expect(preferences.getNewChatFallbackWorkId(OWNER_ID, PROJECT_ID)).resolves.toBe(
        OLDER_WORK_ID,
      );
    });

    it("honors archived collection filtering without touching fallback preference", async () => {
      const archived = await routeApp.workRepo.archive(OLDER_WORK_ID);
      expect(archived.status).toBe("archived");

      const response = await handler(event("archived") as never);

      expect(response).toMatchObject({
        value: { works: [{ id: OLDER_WORK_ID, status: "archived" }] },
      });
      await expect(preferences.getNewChatFallbackWorkId(OWNER_ID, PROJECT_ID)).resolves.toBeNull();
    });

    it("conceals a project owned by another writer", async () => {
      requireAppUser.mockResolvedValue({ user: { userId: OTHER_USER_ID }, app: routeApp });

      await expect(handler(event() as never)).rejects.toMatchObject({
        statusCode: 404,
        message: "Project not found",
      });
      await expect(
        preferences.getNewChatFallbackWorkId(OTHER_USER_ID, PROJECT_ID),
      ).resolves.toBeNull();
    });
  });
}
