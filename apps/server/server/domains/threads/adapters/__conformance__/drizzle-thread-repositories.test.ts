/** Drizzle conformance tests for ThreadRepositories against local Postgres. */
import { afterAll, beforeEach, describe, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle thread repositories (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle thread repositories (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { contextSources, documents } = schema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleProjectRepository } = await import(
      "../../../projects/adapters/project-repository/drizzle.js"
    );
    const { createDrizzleWorkRepository } = await import(
      "../../../projects/adapters/work-repository/drizzle.js"
    );
    const { createDrizzleRepositories } = await import("../drizzle/index.js");
    const { createDrizzleEventJournalReader } = await import("../drizzle/event-reader.js");
    const { createDrizzleEventJournalWriter } = await import("../drizzle/event-writer.js");
    const { describeEventJournalConformance } = await import("./event-journal.conformance.js");
    const { THREAD_REPOSITORIES_CONFORMANCE_USER_ID, describeThreadRepositoriesConformance } =
      await import("./thread-repositories.conformance.js");
    const { describeThreadDocumentRepositoriesConformance } = await import(
      "./thread-document-repositories.conformance.js"
    );

    const db = createDb(DATABASE_URL, { max: 1 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        schema.eventJournal,
        schema.turnDocumentTouches,
        schema.turnBlocks,
        schema.modelResponses,
        schema.threadDocuments,
        schema.turns,
        schema.threads,
        schema.works,
        schema.documents,
        schema.folders,
        schema.contextSources,
        schema.projects,
      ]);
    }

    async function seedUsers(): Promise<void> {
      await db
        .insert(schema.users)
        .values(
          conformanceUserValues(THREAD_REPOSITORIES_CONFORMANCE_USER_ID, "thread-repositories"),
        )
        .onConflictDoNothing();
    }

    beforeEach(async () => {
      await truncateAll();
      await seedUsers();
    });

    afterAll(async () => {
      await db.close();
    });

    describeThreadRepositoriesConformance("drizzle", () => {
      const projects = createDrizzleProjectRepository({ db });
      const works = createDrizzleWorkRepository({ db });
      const repos = createDrizzleRepositories(db);
      return { repos, projects, works };
    });

    describeEventJournalConformance("drizzle", () => {
      const projects = createDrizzleProjectRepository({ db });
      const repos = createDrizzleRepositories(db);
      return {
        journalReader: createDrizzleEventJournalReader(db),
        journalWriter: createDrizzleEventJournalWriter(db),
        async createTurn() {
          const project = await projects.create({
            userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
            title: "Project",
          });
          const thread = await repos.threads.create({
            userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
            projectId: project.id,
          });
          return repos.turns.create({ threadId: thread.id, role: "assistant" });
        },
      };
    });

    describeThreadDocumentRepositoriesConformance("drizzle", () => {
      const projects = createDrizzleProjectRepository({ db });
      const repos = createDrizzleRepositories(db);
      return {
        repos,
        projects,
        async createDocument(projectId: string, filename: string) {
          const [source] = await db
            .insert(contextSources)
            .values({
              projectId: projectId,
              name: `Uploads ${filename}`,
              slug: `uploads-${crypto.randomUUID()}`,
              scope: "project",
            })
            .returning({ id: contextSources.id });
          if (!source) throw new Error("Failed to create context source");
          const dot = filename.lastIndexOf(".");
          const name = dot > 0 ? filename.slice(0, dot) : filename;
          const extension = dot > 0 ? filename.slice(dot + 1) : "";
          const [document] = await db
            .insert(documents)
            .values({ contextSourceId: source.id, name, extension, markdownProjection: "" })
            .returning({ id: documents.id });
          if (!document) throw new Error("Failed to create document");
          return document.id;
        },
      };
    });
  });
}
