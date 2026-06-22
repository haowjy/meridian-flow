/** Postgres coverage for collab document activity/projection read-model helpers. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (RUN_DB_TESTS && DATABASE_URL) {
  describe("document activity helpers (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { contextSources, documents, projects, threadDocuments, threads, users, works } =
      await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { and, eq } = await import("drizzle-orm");
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { touchDocumentActivity, updateMarkdownProjection } = await import(
      "./document-activity.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000401";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000402";
    const WORK_ID = "00000000-0000-4000-8000-000000000403";
    const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000404";
    const DOC_ID = "00000000-0000-4000-8000-000000000405";
    const THREAD_ID = "00000000-0000-4000-8000-000000000406";
    const OLD = new Date("2026-01-01T00:00:00.000Z");
    const NOW = new Date("2026-06-22T12:34:56.789Z");

    const db = createDb(DATABASE_URL, { max: 1 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        threadDocuments,
        threads,
        documents,
        contextSources,
        works,
        projects,
        users,
      ]);
    }

    async function ensureFixtures(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(USER_ID, "document-activity"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Activity Project",
        slug: "activity-project",
        lastActivityAt: OLD,
        updatedAt: OLD,
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Activity Work",
        updatedAt: OLD,
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        workId: WORK_ID,
        name: "Activity Source",
        slug: "activity-source",
        scope: "work",
      });
      await db.insert(documents).values({
        id: DOC_ID,
        contextSourceId: CONTEXT_SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
        markdownProjection: "stale projection",
        updatedAt: OLD,
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Activity Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(threadDocuments).values({
        threadId: THREAD_ID,
        documentId: DOC_ID,
        relationship: "editing",
        firstTouchedAt: OLD,
        lastTouchedAt: OLD,
      });
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    it("touches thread, work, project activity and updates the markdown projection", async () => {
      await touchDocumentActivity(db, DOC_ID, THREAD_ID, NOW);
      await updateMarkdownProjection(db, DOC_ID, "fresh projection", NOW);

      const [threadDocument] = await db
        .select({ lastTouchedAt: threadDocuments.lastTouchedAt })
        .from(threadDocuments)
        .where(
          and(eq(threadDocuments.threadId, THREAD_ID), eq(threadDocuments.documentId, DOC_ID)),
        );
      const [work] = await db
        .select({ updatedAt: works.updatedAt })
        .from(works)
        .where(eq(works.id, WORK_ID));
      const [project] = await db
        .select({ updatedAt: projects.updatedAt, lastActivityAt: projects.lastActivityAt })
        .from(projects)
        .where(eq(projects.id, PROJECT_ID));
      const [document] = await db
        .select({
          markdownProjection: documents.markdownProjection,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(eq(documents.id, DOC_ID));

      expect(threadDocument?.lastTouchedAt.toISOString()).toBe(NOW.toISOString());
      expect(work?.updatedAt.toISOString()).toBe(NOW.toISOString());
      expect(project?.updatedAt.toISOString()).toBe(NOW.toISOString());
      expect(project?.lastActivityAt.toISOString()).toBe(NOW.toISOString());
      expect(document?.markdownProjection).toBe("fresh projection");
      expect(document?.updatedAt.toISOString()).toBe(NOW.toISOString());
    });
  });
}
