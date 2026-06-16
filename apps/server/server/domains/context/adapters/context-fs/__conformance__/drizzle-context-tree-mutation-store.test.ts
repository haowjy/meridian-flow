/**
 * Drizzle/Postgres ContextTreeMutationStore conformance harness.
 * Requires DATABASE_URL against a throwaway database (see vitest.db.config.ts).
 */
import { afterAll, beforeEach, describe } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RUN_DB_TESTS || !DATABASE_URL)(
  "drizzle context tree mutation store (postgres)",
  async () => {
    const { createDb } = await import("@meridian/database");
    const { contextSources, documents, folders, projects, users } = await import(
      "@meridian/database/schema"
    );
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { DrizzleContextDocumentStore, DrizzleContextTreeMutationStore } = await import(
      "../drizzle-store.js"
    );
    const { describeContextTreeMutationStoreConformance } = await import(
      "./context-tree-mutation-store.conformance.js"
    );

    const db = createDb(DATABASE_URL ?? "postgresql://skip:skip@localhost:1/skip", { max: 4 });
    const userId = "00000000-0000-4000-8000-000000000111";
    const projectId = "00000000-0000-4000-8000-0000000000aa";
    const sourceA = "00000000-0000-4000-8000-0000000000a1";
    const sourceB = "00000000-0000-4000-8000-0000000000b1";

    beforeEach(async () => {
      await truncateDrizzleTables(db, [documents, folders, contextSources, projects, users]);
      await db
        .insert(users)
        .values(conformanceUserValues(userId, "context-tree-mutation"))
        .onConflictDoNothing();
      await db.insert(projects).values({
        id: projectId,
        userId,
        name: "Conformance Project",
        slug: "conformance-project",
      });
      await db.insert(contextSources).values([
        {
          id: sourceA,
          projectId,
          name: "Source A",
          slug: "source-a",
          scope: "project",
        },
        {
          id: sourceB,
          projectId,
          name: "Source B",
          slug: "source-b",
          scope: "project",
        },
      ]);
    });

    afterAll(async () => {
      await db.$client.end();
    });

    describeContextTreeMutationStoreConformance("drizzle", () => ({
      sourceA,
      sourceB,
      storeA: new DrizzleContextDocumentStore({ db, contextSourceId: sourceA }),
      storeB: new DrizzleContextDocumentStore({ db, contextSourceId: sourceB }),
      mutationStore: new DrizzleContextTreeMutationStore(db),
    }));
  },
);
