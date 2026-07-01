/** Integration coverage for Drizzle thread list projections that depend on SQL aggregates. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000001001";
const PROJECT_ID = "00000000-0000-4000-8000-000000001002";
const WORK_ID = "00000000-0000-4000-8000-000000001003";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000001004";
const THREAD_EMPTY_ID = "00000000-0000-4000-8000-000000001005";
const THREAD_MIXED_ID = "00000000-0000-4000-8000-000000001006";
const THREAD_MULTI_ID = "00000000-0000-4000-8000-000000001007";
const DOC_TERMINAL_ID = "00000000-0000-4000-8000-000000001008";
const DOC_ACTIVE_ID = "00000000-0000-4000-8000-000000001009";
const DOC_MULTI_A_ID = "00000000-0000-4000-8000-000000001010";
const DOC_MULTI_B_ID = "00000000-0000-4000-8000-000000001011";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle thread repository list projections (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle thread repository list projections (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      contextSources,
      documentYjsDrafts,
      documents,
      projects,
      threadWorks,
      threads,
      users,
      works,
    } = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleThreadRepository } = await import("./thread-repository.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);

    const db = createDb(DATABASE_URL, { max: 2 });
    const repo = createDrizzleThreadRepository(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsDrafts,
        threadWorks,
        threads,
        documents,
        contextSources,
        works,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "thread-list-drafts"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Thread list draft counts",
        slug: "thread-list-draft-counts",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Chapter Work",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Project Source",
        slug: "project-source",
        scope: "project",
      });
      await db
        .insert(documents)
        .values([
          documentValues(DOC_TERMINAL_ID, "terminal"),
          documentValues(DOC_ACTIVE_ID, "active"),
          documentValues(DOC_MULTI_A_ID, "multi-a"),
          documentValues(DOC_MULTI_B_ID, "multi-b"),
        ]);
      await db
        .insert(threads)
        .values([
          threadValues(THREAD_EMPTY_ID, "No drafts"),
          threadValues(THREAD_MIXED_ID, "Mixed drafts"),
          threadValues(THREAD_MULTI_ID, "Multi active drafts"),
        ]);
      await db
        .insert(threadWorks)
        .values([
          threadWorkValues(THREAD_EMPTY_ID),
          threadWorkValues(THREAD_MIXED_ID),
          threadWorkValues(THREAD_MULTI_ID),
        ]);
      await db
        .insert(documentYjsDrafts)
        .values([
          draftValues("draft_terminal", DOC_TERMINAL_ID, THREAD_MIXED_ID, "applied"),
          draftValues("draft_active", DOC_ACTIVE_ID, THREAD_MIXED_ID, "active"),
          draftValues("draft_multi_a", DOC_MULTI_A_ID, THREAD_MULTI_ID, "active"),
          draftValues("draft_multi_b", DOC_MULTI_B_ID, THREAD_MULTI_ID, "active"),
        ]);
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("projects active-only pendingDraftCount for listByProject and listByWork", async () => {
      const byProject = await repo.listByProject(PROJECT_ID as never);
      const byWork = await repo.listByWork(PROJECT_ID as never, WORK_ID);

      expect(countByThread(byProject)).toMatchObject({
        [THREAD_EMPTY_ID]: 0,
        [THREAD_MIXED_ID]: 1,
        [THREAD_MULTI_ID]: 2,
      });
      expect(countByThread(byWork)).toMatchObject({
        [THREAD_EMPTY_ID]: 0,
        [THREAD_MIXED_ID]: 1,
        [THREAD_MULTI_ID]: 2,
      });
    });
  });
}

function threadValues(id: string, title: string) {
  return {
    id,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title,
    kind: "primary",
    status: "idle",
  };
}

function threadWorkValues(threadId: string) {
  return {
    threadId,
    workId: WORK_ID,
    projectId: PROJECT_ID,
    isPrimary: true,
  };
}

function documentValues(id: string, name: string) {
  return {
    id,
    contextSourceId: CONTEXT_SOURCE_ID,
    name,
    extension: "md",
    fileType: "markdown",
  };
}

function draftValues(
  id: string,
  documentId: string,
  threadId: string,
  status: "active" | "applied" | "discarded",
) {
  return {
    id,
    documentId,
    threadId,
    status,
  };
}

function countByThread(rows: Array<{ id: string; pendingDraftCount: number }>) {
  return Object.fromEntries(rows.map((row) => [row.id, row.pendingDraftCount]));
}
