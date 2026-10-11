/** Postgres account JSONB patches and retirement preserve independent preferences. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  projects,
  projectUserPreferences,
  threads,
  threadUserState,
  userPreferences,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { useRollbackTestDatabase } from "../../../../test-support/drizzle-reset.js";
import { createDrizzleAccountSettingsRepository } from "./account-settings-repository.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("account settings (postgres)", () => {});
else
  describe("account settings (postgres)", () => {
    const database = useRollbackTestDatabase(DATABASE_URL);
    const id = "00000000-0000-4000-8000-000000000861" as UserId;
    beforeEach(async () => {
      await database.current.insert(users).values(conformanceUserValues(id, "account-settings"));
    });
    it("stores partial patches in JSONB without losing unrelated fields or sync", async () => {
      const db = database.current;
      const repository = createDrizzleAccountSettingsRepository({ db });
      expect(await repository.read(id)).toEqual({
        ...DEFAULT_ACCOUNT_APPEARANCE,
        workingSetSyncEnabled: true,
      });
      await repository.update(id, { theme: "dark" });
      await repository.update(id, {
        language: "zh",
        statsForNerds: true,
        workingSetSyncEnabled: false,
      });
      expect(await repository.read(id)).toEqual({
        theme: "dark",
        language: "zh",
        statsForNerds: true,
        workingSetSyncEnabled: false,
      });
      const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, id));
      expect(row?.preferences).toEqual({ theme: "dark", language: "zh", statsForNerds: true });
    });
    it("retires obsolete columns from a populated row without removing its runtime policy", async () => {
      const db = database.current;
      const [project] = await db
        .insert(projects)
        .values({ userId: id, name: "Preference migration", slug: "preference-migration" })
        .returning();
      if (!project) throw new Error("Project fixture missing");
      await db.insert(projectUserPreferences).values({
        userId: id,
        projectId: project.id,
        autoResumeEnabled: false,
        autoResumeTimeoutMs: 12345,
      });
      const otherUser = randomUUID() as UserId;
      await db.insert(users).values(conformanceUserValues(otherUser, "foreign-pins"));
      const [otherProject] = await db
        .insert(projects)
        .values({ userId: otherUser, name: "Foreign", slug: "foreign" })
        .returning();
      if (!otherProject) throw new Error("Foreign project fixture missing");
      const [pinned, missingState, alreadyFavorite, unpinned, foreign, deleted, foreignAuthor] =
        Array.from({ length: 7 }, () => randomUUID() as ThreadId);
      if (
        !pinned ||
        !missingState ||
        !alreadyFavorite ||
        !unpinned ||
        !foreign ||
        !deleted ||
        !foreignAuthor
      )
        throw new Error("Thread fixture missing");
      await db.insert(threads).values(
        [pinned, missingState, alreadyFavorite, unpinned, foreign, deleted, foreignAuthor].map(
          (threadId) => ({
            id: threadId,
            rootThreadId: threadId,
            projectId: threadId === foreign ? otherProject.id : project.id,
            createdByUserId: threadId === foreign || threadId === foreignAuthor ? otherUser : id,
            deletedAt: threadId === deleted ? new Date() : null,
          }),
        ),
      );
      await db.insert(threadUserState).values([
        { threadId: pinned, userId: id, isFavorite: false },
        { threadId: alreadyFavorite, userId: id, isFavorite: true },
        { threadId: unpinned, userId: id, isFavorite: true },
      ]);
      // A preference row alone cannot grant another account visibility to this project.
      await db.insert(projectUserPreferences).values({ userId: otherUser, projectId: project.id });
      // Restore the exact pre-retirement shape inside this rollback-isolated case.
      await db.execute(
        sql`ALTER TABLE project_user_preferences ADD COLUMN thread_group_by text NOT NULL DEFAULT 'work', ADD COLUMN pinned_thread_ids text[] NOT NULL DEFAULT '{}', ADD CONSTRAINT project_user_preferences_thread_group_by_check CHECK (thread_group_by IN ('work','date','flat'))`,
      );
      await db.execute(
        sql`UPDATE project_user_preferences SET thread_group_by = 'date', pinned_thread_ids = ARRAY[${sql.join(
          [
            pinned,
            missingState,
            alreadyFavorite,
            pinned,
            foreign,
            deleted,
            foreignAuthor,
            randomUUID(),
            "not-a-uuid",
          ].map((pin) => sql`${pin}`),
          sql`, `,
        )}] WHERE user_id = ${id}`,
      );
      await db.execute(
        sql`UPDATE project_user_preferences SET pinned_thread_ids = ARRAY[${pinned}] WHERE user_id = ${otherUser}`,
      );
      const migration = readFileSync(
        new URL(
          "../../../../../../../packages/database/src/migrations/0036_famous_nightcrawler.sql",
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        await db.execute(sql.raw(statement));
      const [row] = await db
        .select()
        .from(projectUserPreferences)
        .where(eq(projectUserPreferences.userId, id));
      const favorites = await db
        .select()
        .from(threadUserState)
        .where(eq(threadUserState.userId, id));
      expect(favorites.map((row) => row.threadId).sort()).toEqual(
        [pinned, missingState, alreadyFavorite, unpinned].sort(),
      );
      expect(favorites.every((row) => row.isFavorite)).toBe(true);
      expect(
        await db.select().from(threadUserState).where(eq(threadUserState.userId, otherUser)),
      ).toEqual([]);
      expect(row?.autoResumeEnabled).toBe(false);
      expect(row?.autoResumeTimeoutMs).toBe(12345);
      const columns = await db.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_user_preferences'`,
      );
      expect(columns.map((column) => column.column_name)).not.toContain("thread_group_by");
      expect(columns.map((column) => column.column_name)).not.toContain("pinned_thread_ids");
    });
  });
