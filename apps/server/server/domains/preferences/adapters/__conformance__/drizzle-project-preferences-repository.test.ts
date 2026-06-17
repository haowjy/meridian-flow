/**
 * Drizzle conformance for the persisted project preference repository.
 *
 * Opt in with RUN_DB_TESTS=1 DATABASE_URL=... against a migrated local Postgres
 * database. The default test suite uses the in-memory adapter and skips this
 * database-facing spec.
 */

import { createDb, projects, projectUserPreferences } from "@meridian/database";
import { dbTestFixtureEmail, seedUser } from "@meridian/database/__test-support__/db-fixtures";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe } from "vitest";
import { createDrizzleProjectPreferencesRepository } from "../drizzle/project-preferences-repository.js";
import { describeProjectPreferencesRepositoryConformance } from "./project-preferences-repository.conformance.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

const ids = {
  userId: "00000000-0000-4000-8000-000000000101",
  otherUserId: "00000000-0000-4000-8000-000000000102",
  projectId: "00000000-0000-4000-8000-000000000201",
  otherProjectId: "00000000-0000-4000-8000-000000000202",
};

describe.skipIf(!RUN_DB_TESTS || !DATABASE_URL)(
  "drizzle project preferences repository (postgres)",
  async () => {
    if (!DATABASE_URL) return;

    const db = createDb(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await db.delete(projectUserPreferences);
      await db.delete(projects).where(inArray(projects.id, [ids.projectId, ids.otherProjectId]));
      await seedUser(db, ids.userId, dbTestFixtureEmail("preferences-conformance-1"));
      await seedUser(db, ids.otherUserId, dbTestFixtureEmail("preferences-conformance-2"));
      await db.insert(projects).values([
        {
          id: ids.projectId,
          userId: ids.userId,
          name: "Preferences conformance",
          slug: "preferences-conformance",
        },
        {
          id: ids.otherProjectId,
          userId: ids.userId,
          name: "Preferences conformance other",
          slug: "preferences-conformance-other",
        },
      ]);
    });

    afterAll(async () => {
      await db.delete(projectUserPreferences);
      await db.delete(projects).where(inArray(projects.id, [ids.projectId, ids.otherProjectId]));
      await db.execute(sql`
        DELETE FROM public.users
        WHERE id IN (${ids.userId}::uuid, ${ids.otherUserId}::uuid)
      `);
      await db.close();
    });

    describeProjectPreferencesRepositoryConformance(
      "drizzle",
      () => createDrizzleProjectPreferencesRepository({ db }),
      ids,
    );
  },
);
