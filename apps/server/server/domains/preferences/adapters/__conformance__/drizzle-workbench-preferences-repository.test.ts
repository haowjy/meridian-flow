/**
 * Drizzle conformance for the persisted workbench preference repository.
 *
 * Opt in with RUN_DB_TESTS=1 DATABASE_URL=... against a migrated local Supabase
 * database. The default test suite uses the in-memory adapter and skips this
 * database-facing spec.
 */
import { createDb, projects, workbenchUserPreferences } from "@meridian/database";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe } from "vitest";
import { createDrizzleWorkbenchPreferencesRepository } from "../drizzle/workbench-preferences-repository.js";
import { describeWorkbenchPreferencesRepositoryConformance } from "./workbench-preferences-repository.conformance.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

const ids = {
  userId: "00000000-0000-4000-8000-000000000101",
  otherUserId: "00000000-0000-4000-8000-000000000102",
  workbenchId: "00000000-0000-4000-8000-000000000201",
  otherWorkbenchId: "00000000-0000-4000-8000-000000000202",
};

describe.skipIf(!RUN_DB_TESTS || !DATABASE_URL)(
  "drizzle workbench preferences repository (postgres)",
  async () => {
    if (!DATABASE_URL) return;

    const db = createDb(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await db.delete(workbenchUserPreferences);
      await db
        .delete(projects)
        .where(inArray(projects.id, [ids.workbenchId, ids.otherWorkbenchId]));
      await seedAuthUser(db, ids.userId, "preferences-conformance-1@example.test");
      await seedAuthUser(db, ids.otherUserId, "preferences-conformance-2@example.test");
      await db.insert(projects).values([
        {
          id: ids.workbenchId,
          userId: ids.userId,
          name: "Preferences conformance",
          slug: "preferences-conformance",
        },
        {
          id: ids.otherWorkbenchId,
          userId: ids.userId,
          name: "Preferences conformance other",
          slug: "preferences-conformance-other",
        },
      ]);
    });

    afterAll(async () => {
      await db.delete(workbenchUserPreferences);
      await db
        .delete(projects)
        .where(inArray(projects.id, [ids.workbenchId, ids.otherWorkbenchId]));
      await db.execute(sql`
        DELETE FROM auth.users
        WHERE id IN (${ids.userId}::uuid, ${ids.otherUserId}::uuid)
      `);
      await db.close();
    });

    describeWorkbenchPreferencesRepositoryConformance(
      "drizzle",
      () => createDrizzleWorkbenchPreferencesRepository({ db }),
      ids,
    );
  },
);

type TestDb = ReturnType<typeof createDb>;

async function seedAuthUser(db: TestDb, id: string, email: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO auth.users (
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    )
    VALUES (
      ${id}::uuid,
      'authenticated',
      'authenticated',
      ${email},
      '',
      now(),
      '{}'::jsonb,
      '{}'::jsonb,
      now(),
      now()
    )
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()
  `);
}
