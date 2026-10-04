/** Postgres file facts: ownership, lifecycle, path and the ancestor chain. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  folderAncestors,
  folders,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createDrizzleFileFacts, refreshFolderAncestors } from "./drizzle-file-facts.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle file facts (postgres)", () => {});
} else {
  describe("drizzle file facts (postgres)", () => {
    const u = "00000000-0000-4000-8000-000000000a00";
    const p = "00000000-0000-4000-8000-000000000a01";
    const noWork = "00000000-0000-4000-8000-000000000a02";
    const a = "00000000-0000-4000-8000-000000000a03";
    const manuscript = "00000000-0000-4000-8000-000000000a10";
    const scratch = "00000000-0000-4000-8000-000000000a11";
    const chapters = "00000000-0000-4000-8000-000000000a20";
    const arc = "00000000-0000-4000-8000-000000000a21";
    const chapter = "00000000-0000-4000-8000-000000000a30";
    const note = "00000000-0000-4000-8000-000000000a31";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "file-facts"));
      await db.insert(projects).values({ id: p, userId: u, name: "Serial", slug: "serial" });
      await db.insert(works).values([
        { id: noWork, projectId: p, createdByUserId: u, name: "No Work", isNoWork: true },
        { id: a, projectId: p, createdByUserId: u, name: "Arc A", slug: "arc-a" },
      ]);
      await db.insert(contextSources).values([
        { id: manuscript, projectId: p, name: "Manuscript", slug: "manuscript" },
        { id: scratch, workId: a, scope: "work", name: "Scratch", slug: "scratch" },
      ]);
      await db.insert(folders).values([
        { id: chapters, contextSourceId: manuscript, name: "chapters" },
        { id: arc, contextSourceId: manuscript, parentId: chapters, name: "arc-1" },
      ]);
      await db.insert(documents).values([
        { id: chapter, contextSourceId: manuscript, folderId: arc, name: "ch1" },
        { id: note, contextSourceId: scratch, name: "notes" },
      ]);
    });

    it("loads documents, drafts and containers with their ancestors", async () => {
      const facts = createDrizzleFileFacts(database.current);
      const ch1 = await facts.load({ target: { kind: "document", documentId: chapter } });
      expect(ch1).toMatchObject({
        projectId: p,
        ownerAccountId: u,
        projectDeleted: false,
        ownerWork: null,
        deleted: false,
        scheme: "manuscript",
        path: "chapters/arc-1/ch1.md",
        self: { kind: "document", id: chapter },
        ancestors: [
          { kind: "folder", id: arc },
          { kind: "folder", id: chapters },
          { kind: "source", id: manuscript },
          { kind: "project", id: p },
        ],
      });

      const scratchNote = await facts.load({ target: { kind: "document", documentId: note } });
      expect(scratchNote?.ownerWork).toEqual({
        id: a,
        slug: "arc-a",
        isNoWork: false,
        archived: false,
        deleted: false,
      });
      expect(scratchNote?.ancestors).toEqual([
        { kind: "source", id: scratch },
        { kind: "work", id: a },
        { kind: "project", id: p },
      ]);

      const drafted = await facts.load({
        target: { kind: "document", documentId: chapter },
        draftWorkId: a,
      });
      expect(drafted?.draftWork?.id).toBe(a);

      const container = await facts.load({
        target: { kind: "container", scheme: "scratch", owner: { scope: "work", workId: a } },
      });
      expect(container).toMatchObject({ self: null, path: "", ownerWork: { id: a } });
      expect(container?.ancestors).toEqual(scratchNote?.ancestors);

      expect(
        await facts.load({ target: { kind: "document", documentId: crypto.randomUUID() } }),
      ).toBeNull();
    });

    it("reads lifecycle through folders and Works, under locks too", async () => {
      const db = database.current;
      await db.update(folders).set({ deletedAt: new Date() }).where(eq(folders.id, chapters));
      await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, a));
      const [ch1, scratchNote] = await createDrizzleFileFacts(db).loadLocked([
        { target: { kind: "document", documentId: chapter } },
        { target: { kind: "document", documentId: note } },
      ]);
      expect(ch1?.deleted).toBe(true);
      expect(scratchNote?.ownerWork?.archived).toBe(true);
    });

    it("keeps the folder closure in the facts' order", async () => {
      const db = database.current;
      await refreshFolderAncestors(db, [chapters]);
      const rows = await db
        .select({ ancestorId: folderAncestors.ancestorId })
        .from(folderAncestors)
        .where(eq(folderAncestors.folderId, arc))
        .orderBy(asc(folderAncestors.depth));
      expect(rows.map((row) => row.ancestorId)).toEqual([arc, chapters]);
    });
  });
}
