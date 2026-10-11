/** Corpus intake preserves writer titles and allocates against live KB names. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { documents, projects, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import { createTestDocumentLinkScopes } from "../../collab/test-support/document-link-scopes.js";
import { createDrizzleContextCatalog } from "../adapters/context-catalog.js";
import { createProductionUnifiedContextPortFactory } from "../unified-context-port-factory.js";
import { createCorpusImportService } from "./corpus-import-service.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!RUN || !DATABASE_URL) describe.skip("corpus intake (postgres)", () => {});
else
  describe("corpus intake (postgres)", () => {
    const USER = "00000000-0000-4000-8000-000000000b01";
    const PROJECT = "00000000-0000-4000-8000-000000000b02";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    it("keeps DOCX and dotted titles, directory names and numbered collisions across batches", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER, "corpus-intake"));
      await db
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Project", slug: "project" });
      const collab = createInMemoryCollabDomain();
      const catalog = createDrizzleContextCatalog(db);
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        links: createTestDocumentLinkScopes(db),
        documentSync: collab,
        manifestMembership: collab,
        catalogMutations: catalog,
      });
      const service = createCorpusImportService({
        contextPorts,
        converter: {
          classify: () => "docx",
          convert: async () => ({ markdown: "The story begins.", messages: [] }),
        },
      });
      const file = (filename: string, relativePath?: string) => ({
        filename,
        relativePath,
        bytes: new Uint8Array(),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const request = { projectId: PROJECT, userId: USER, source: { kind: "upload" as const } };
      const first = await service.importFiles({
        ...request,
        files: [
          file("Chapter 13.docx"),
          file("Vol. 2.docx"),
          file("Chapter 13.docx"),
          file("Lin-Feng.docx", "Cast Notes/Lin-Feng.docx"),
        ],
      });
      const second = await service.importFiles({ ...request, files: [file("Chapter 13.docx")] });
      expect(first).toMatchObject({
        importedCount: 4,
        failedCount: 0,
        items: [
          { title: "Chapter 13", uri: "kb://imports/Chapter 13" },
          { title: "Vol. 2", uri: "kb://imports/Vol. 2" },
          { title: "Chapter 13", uri: "kb://imports/Chapter 13 (2)" },
          { title: "Lin-Feng", uri: "kb://imports/Cast Notes/Lin-Feng" },
        ],
      });
      expect(second).toMatchObject({
        importedCount: 1,
        items: [{ uri: "kb://imports/Chapter 13 (3)" }],
      });
      for (const item of [...first.items, ...second.items]) {
        if (item.status !== "imported" || !item.documentId) throw new Error("import failed");
        const [document] = await db
          .select()
          .from(documents)
          .where(eq(documents.id, item.documentId as never));
        expect(document).toMatchObject({ extension: "", fileType: "markdown" });
        expect(await collab.readAsMarkdown(item.documentId as never)).toEqual({
          ok: true,
          value: `# ${item.title}\n\nThe story begins.\n`,
        });
      }
    });
  });
