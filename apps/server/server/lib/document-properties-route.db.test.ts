/**
 * The properties read authorizes by the document's read grant, as document reads do:
 * the writer's own files open from any project they own, a stranger's never do.
 */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, users } from "@meridian/database/schema";
import { describe, expect, it } from "vitest";
import { createDrizzleDocumentPropertiesReader } from "../domains/context/index.js";
import { createProjectRepositoryForTest } from "../domains/projects/test-support/project-repository.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../test-support/drizzle-reset.js";
import { drizzleFileAccess } from "../test-support/file-grants.js";
import { readDocumentPropertiesForRoute } from "./document-properties-route.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN =
  (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") && DATABASE_URL;

if (!RUN) {
  describe.skip("document properties route (postgres)", () => {});
} else {
  describe("document properties route (postgres)", () => {
    const WRITER = "00000000-0000-4000-8000-000000000b01";
    const STRANGER = "00000000-0000-4000-8000-000000000b02";
    const BOOK = "00000000-0000-4000-8000-000000000b11";
    const OTHER_BOOK = "00000000-0000-4000-8000-000000000b12";
    const USER_FILES = "00000000-0000-4000-8000-000000000b13";
    const STRANGER_BOOK = "00000000-0000-4000-8000-000000000b14";
    const BOOK_DOC = "00000000-0000-4000-8000-000000000b21";
    const USER_DOC = "00000000-0000-4000-8000-000000000b22";
    const STRANGER_DOC = "00000000-0000-4000-8000-000000000b23";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    async function seed() {
      const db = database.current;
      await db
        .insert(users)
        .values([
          conformanceUserValues(WRITER, "properties-writer"),
          conformanceUserValues(STRANGER, "properties-stranger"),
        ]);
      await db.insert(projects).values([
        { id: BOOK, userId: WRITER, name: "Book", slug: "book" },
        { id: OTHER_BOOK, userId: WRITER, name: "Other", slug: "other" },
        {
          id: USER_FILES,
          userId: WRITER,
          name: "User Files",
          slug: "user-files",
          isPersonal: true,
        },
        { id: STRANGER_BOOK, userId: STRANGER, name: "Theirs", slug: "theirs" },
      ]);
      const sources = [
        { projectId: BOOK, slug: "manuscript" },
        { projectId: USER_FILES, slug: "user" },
        { projectId: STRANGER_BOOK, slug: "manuscript" },
      ];
      const sourceIds = await db
        .insert(contextSources)
        .values(
          sources.map(({ projectId, slug }) => ({
            projectId,
            name: slug,
            slug,
            scope: "project" as const,
          })),
        )
        .returning({ id: contextSources.id });
      const properties = { format: "yaml", text: "aliases: [Gate]\ntags: [a, b]\n" };
      await db.insert(documents).values(
        [BOOK_DOC, USER_DOC, STRANGER_DOC].map((id, index) => ({
          id,
          contextSourceId: sourceIds[index]?.id as string,
          name: `doc-${index}`,
          extension: "",
          fileType: "markdown" as const,
          mimeType: "text/markdown",
          sizeBytes: 0,
          markdownProjection: "",
          metadata: { properties },
        })),
      );
      return {
        read: (input: { userId: string; projectId: string; documentId: string }) =>
          readDocumentPropertiesForRoute(
            {
              fileAccess: drizzleFileAccess(db),
              projectRepo: createProjectRepositoryForTest({ db }),
              documentProperties: createDrizzleDocumentPropertiesReader(db),
            },
            input,
          ),
      };
    }

    it("serves a document of the project being viewed", async () => {
      const { read } = await seed();
      const result = await read({ userId: WRITER, projectId: BOOK, documentId: BOOK_DOC });
      expect(result.entries.map((entry) => entry.key)).toEqual(["aliases", "tags"]);
    });

    it("serves the writer's User file from an ordinary project, though it is stored in their personal one", async () => {
      const { read } = await seed();
      const result = await read({ userId: WRITER, projectId: BOOK, documentId: USER_DOC });
      expect(result.aliases).toEqual(["Gate"]);
    });

    it("serves another project of the writer's, as reading its content would", async () => {
      const { read } = await seed();
      await expect(
        read({ userId: WRITER, projectId: OTHER_BOOK, documentId: BOOK_DOC }),
      ).resolves.toMatchObject({ unreadable: false });
    });

    it("refuses another account's document, even from the writer's own project", async () => {
      const { read } = await seed();
      await expect(
        read({ userId: WRITER, projectId: BOOK, documentId: STRANGER_DOC }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("refuses another account's project and its own documents", async () => {
      const { read } = await seed();
      await expect(
        read({ userId: STRANGER, projectId: BOOK, documentId: BOOK_DOC }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        read({ userId: STRANGER, projectId: STRANGER_BOOK, documentId: BOOK_DOC }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("answers 404 for a document with no properties", async () => {
      const { read } = await seed();
      await expect(
        read({
          userId: WRITER,
          projectId: BOOK,
          documentId: "00000000-0000-4000-8000-0000000000ff",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
}
