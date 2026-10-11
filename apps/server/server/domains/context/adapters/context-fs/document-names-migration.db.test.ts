/** Seeded upgrade contract: normalize historical content and every mutable address. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentLinks,
  documentPreviousLocations,
  documents,
  folders,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useRollbackTestDatabase } from "../../../../test-support/drizzle-reset.js";

const enabled = process.env.RUN_DB_TESTS === "1" && process.env.DATABASE_URL;
if (!enabled) describe.skip("document name migration", () => {});
else
  describe("document name migration", () => {
    const database = useRollbackTestDatabase(enabled);
    it("preserves prose, allocates collision names, and updates deleted rows, aliases and ahead refs", async () => {
      const db = database.current;
      const userId = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, "document-names-migration"));
      await db.insert(projects).values({ id: projectId, userId, name: "Naming", slug: "naming" });
      await db.insert(contextSources).values({
        id: sourceId,
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(folders).values({ contextSourceId: sourceId, name: "Lore" });
      const fixtures = [
        ["chapter", "md", "markdown", "chapter"],
        ["notes", "txt", "text", "notes"],
        ["long", "markdown", "markdown", "long"],
        ["plain", "", "markdown", "plain"],
        ["Vol", " 2", "text", "Vol. 2"],
        ["data.json", "md", "markdown", "data.json (2)"],
        ["twin", "", "markdown", "twin"],
        ["twin", "md", "markdown", "twin (3)"],
        ["twin (2)", "md", "markdown", "twin (2)"],
        ["Lore", "md", "markdown", "Lore (2)"],
        ["gone", "TXT", "text", "gone"],
        ["config", "TOML", "text", "config"],
      ];
      const rows = fixtures.map(([name, extension, fileType]) => ({
        id: crypto.randomUUID(),
        contextSourceId: sourceId,
        name: name ?? "",
        extension,
        fileType,
        deletedAt: name === "gone" ? new Date() : null,
      }));
      await db.insert(documents).values(rows);
      const chapter = rows[0];
      if (!chapter) throw new Error("fixture missing");
      await db
        .insert(documentPreviousLocations)
        .values({ contextSourceId: sourceId, documentId: chapter.id, path: "before/chapter.md" });
      await db.insert(linkAheadRefs).values({
        aheadId: crypto.randomUUID(),
        projectId,
        scheme: "manuscript",
        path: "chapter.md",
        settledDocumentId: chapter.id,
      });
      await db.insert(documentLinks).values({
        sourceDocumentId: chapter.id,
        linkKey: `doc:${chapter.id}`,
        targetDocumentId: chapter.id,
        address: "manuscript://chapter.md",
        occurrences: 1,
      });
      const migration = readFileSync(
        fileURLToPath(
          new URL(
            "../../../../../../../packages/database/src/migrations/0037_old_adam_destine.sql",
            import.meta.url,
          ),
        ),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.execute(sql.raw(statement));
      }
      const stored = await db
        .select()
        .from(documents)
        .where(eq(documents.contextSourceId, sourceId));
      for (const [index, fixture] of fixtures.entries()) {
        const row = stored.find((row) => row.id === rows[index]?.id);
        expect(row).toMatchObject({
          name: fixture[3],
          extension: fixture[1] === "TOML" ? "toml" : "",
          fileType: fixture[1] === "TOML" ? "text" : "markdown",
        });
      }
      expect(
        (
          await db
            .select()
            .from(documentPreviousLocations)
            .where(eq(documentPreviousLocations.contextSourceId, sourceId))
        )[0]?.path,
      ).toBe("before/chapter");
      expect(
        (await db.select().from(linkAheadRefs).where(eq(linkAheadRefs.projectId, projectId)))[0]
          ?.path,
      ).toBe("chapter");
      expect(
        (
          await db
            .select()
            .from(documentLinks)
            .where(eq(documentLinks.sourceDocumentId, chapter.id))
        )[0]?.address,
      ).toBe("manuscript://chapter");
      expect(stored.find((row) => row.name === "gone")?.deletedAt).not.toBeNull();
    });
  });
