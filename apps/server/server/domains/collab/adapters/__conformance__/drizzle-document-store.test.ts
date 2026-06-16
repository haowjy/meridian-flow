/** Drizzle conformance tests for DocumentStore against local Postgres. */
import { afterAll, beforeEach, describe, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle document store (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle document store (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const {
      contextSources,
      documentRestorePoints,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsUpdates,
      documents,
      folders,
      projects,
    } = schema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleDocumentStore } = await import("../drizzle/document-store.js");
    const { describeDocumentStoreConformance, documentStoreConformanceFixtures } = await import(
      "./document-store.conformance.js"
    );

    const db = createDb(DATABASE_URL, { max: 1 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        documentRestorePoints,
        documentYjsHeads,
        documentYjsUpdates,
        documentYjsCheckpoints,
        documents,
        folders,
        contextSources,
        projects,
      ]);
    }

    async function ensureFixtures(): Promise<void> {
      const fixtures = documentStoreConformanceFixtures;
      const [docA, docB, docC] = fixtures.documentIds;

      await db
        .insert(schema.users)
        .values(conformanceUserValues(fixtures.userId, "document-store"))
        .onConflictDoNothing();
      await db.insert(projects).values({
        id: fixtures.contextSourceId,
        userId: fixtures.userId,
        name: "Conformance Project",
        slug: "conformance-project",
      });
      await db.insert(contextSources).values({
        id: fixtures.contextSourceId,
        projectId: fixtures.contextSourceId,
        name: "Conformance Source",
        slug: "conformance-source",
        scope: "project",
      });
      await db.insert(documents).values([
        { id: docA, contextSourceId: fixtures.contextSourceId, name: "doc-a", extension: "md" },
        { id: docB, contextSourceId: fixtures.contextSourceId, name: "doc-b", extension: "md" },
        { id: docC, contextSourceId: fixtures.contextSourceId, name: "doc-c", extension: "md" },
      ]);
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    describeDocumentStoreConformance("drizzle", () => createDrizzleDocumentStore(db));
  });
}
