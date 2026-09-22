/** Postgres proof for recent-document ownership, work identity, soft-delete cap, and binaries. */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  projects,
  userRecentDocuments,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../../test-support/rollback-test-database.js";
import {
  RecentDocumentUnavailableError,
  USER_RECENT_DOCUMENTS_CAP,
} from "../../ports/recent-documents-repository.js";
import { createDrizzleRecentDocumentsRepository } from "./recent-documents-repository.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const USER = id(0x1001);
const OTHER = id(0x1002);
const PROJECT = id(0x1003);
const FOREIGN_PROJECT = id(0x1004);
const PERSONAL = id(0x1005);
const NO_WORK = id(0x1006);
const WORK = id(0x1007);
const MANUSCRIPT = id(0x1008);
const WORK_SCRATCH = id(0x1009);
const NO_WORK_SCRATCH = id(0x100a);
const USER_SOURCE = id(0x100b);
const FOREIGN_SOURCE = id(0x100c);
const OWNED = id(0x1010);
const SCRATCH = id(0x1011);
const NO_WORK_DOC = id(0x1012);
const PERSONAL_DOC = id(0x1013);
const FOREIGN_DOC = id(0x1014);
const PDF = id(0x1015);
const DOOMED = id(0x1016);
const MISSING = id(0x1099);

const userId = (value: string) => value as UserId;
const documentId = (value: string) => value as DocumentId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle recent documents repository (postgres)", () => {});
} else {
  describe("drizzle recent documents repository (postgres)", () => {
    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });

    async function seed() {
      const db = database.current;
      await db
        .insert(users)
        .values([
          conformanceUserValues(USER, "recent-documents"),
          conformanceUserValues(OTHER, "recent-documents-other"),
        ]);
      await db.insert(projects).values([
        { id: PROJECT, userId: USER, name: "Serial", slug: "serial" },
        { id: FOREIGN_PROJECT, userId: OTHER, name: "Foreign", slug: "foreign" },
        { id: PERSONAL, userId: USER, name: "Personal", slug: "personal", isPersonal: true },
      ]);
      await db.insert(works).values([
        {
          id: NO_WORK,
          projectId: PROJECT,
          createdByUserId: USER,
          name: "No Work",
          slug: null,
          isNoWork: true,
        },
        {
          id: WORK,
          projectId: PROJECT,
          createdByUserId: USER,
          name: "Draft",
          slug: "draft",
        },
      ]);
      await db.insert(contextSources).values([
        { id: MANUSCRIPT, projectId: PROJECT, name: "Manuscript", slug: "manuscript" },
        { id: WORK_SCRATCH, workId: WORK, scope: "work", name: "Work scratch", slug: "scratch" },
        {
          id: NO_WORK_SCRATCH,
          workId: NO_WORK,
          scope: "work",
          name: "Scratch",
          slug: "scratch",
        },
        { id: USER_SOURCE, projectId: PERSONAL, name: "User", slug: "user" },
        { id: FOREIGN_SOURCE, projectId: FOREIGN_PROJECT, name: "Foreign", slug: "manuscript" },
      ]);
      await db.insert(documents).values([
        { id: OWNED, contextSourceId: MANUSCRIPT, name: "chapter", extension: "md" },
        { id: SCRATCH, contextSourceId: WORK_SCRATCH, name: "scene", extension: "md" },
        { id: NO_WORK_DOC, contextSourceId: NO_WORK_SCRATCH, name: "aside", extension: "md" },
        { id: PERSONAL_DOC, contextSourceId: USER_SOURCE, name: "notes", extension: "md" },
        { id: FOREIGN_DOC, contextSourceId: FOREIGN_SOURCE, name: "secret", extension: "md" },
        {
          id: PDF,
          contextSourceId: MANUSCRIPT,
          name: "proof",
          extension: "pdf",
          fileType: "pdf",
          mimeType: "application/pdf",
        },
        { id: DOOMED, contextSourceId: MANUSCRIPT, name: "cut", extension: "md" },
      ]);
      return { db, repo: createDrizzleRecentDocumentsRepository({ db }) };
    }

    it("hides another user's document and rejects a record the user cannot see", async () => {
      const { db, repo } = await seed();
      await repo.record(userId(USER), documentId(OWNED));
      await expect(repo.listByUser(userId(OTHER))).resolves.toEqual([]);
      await expect(repo.record(userId(OTHER), documentId(OWNED))).rejects.toBeInstanceOf(
        RecentDocumentUnavailableError,
      );
      await expect(repo.record(userId(USER), documentId(MISSING))).rejects.toBeInstanceOf(
        RecentDocumentUnavailableError,
      );
      await db.insert(userRecentDocuments).values({
        userId: OTHER,
        documentId: OWNED,
        openedAt: new Date(),
      });
      await expect(repo.listByUser(userId(OTHER))).resolves.toEqual([]);
      await expect(repo.listByUser(userId(USER))).resolves.toMatchObject([
        { documentId: OWNED, projectSlug: "serial" },
      ]);
    });

    it("resolves project, scheme, path, and work slug for each identity shape", async () => {
      const { repo } = await seed();
      await repo.record(userId(USER), documentId(SCRATCH));
      await repo.record(userId(USER), documentId(NO_WORK_DOC));
      await repo.record(userId(USER), documentId(PERSONAL_DOC));
      const listed = await repo.listByUser(userId(USER));
      expect(listed).toHaveLength(3);
      expect(listed).toEqual(
        expect.arrayContaining([
          // A work-scoped scratch document carries its work slug.
          expect.objectContaining({
            documentId: SCRATCH,
            projectSlug: "serial",
            scheme: "scratch",
            path: "/scene.md",
            workSlug: "draft",
          }),
          // No Work and the personal project both resolve to a null work slug.
          expect.objectContaining({
            documentId: NO_WORK_DOC,
            projectSlug: "serial",
            scheme: "scratch",
            path: "/aside.md",
            workSlug: null,
          }),
          expect.objectContaining({
            documentId: PERSONAL_DOC,
            projectSlug: "personal",
            scheme: "user",
            path: "/notes.md",
            workSlug: null,
          }),
        ]),
      );
    });

    it("omits a soft-deleted document and does not let it occupy a cap slot", async () => {
      const { db, repo } = await seed();
      await repo.record(userId(USER), documentId(DOOMED));
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, DOOMED));
      await expect(repo.listByUser(userId(USER))).resolves.toEqual([]);
      await expect(repo.record(userId(USER), documentId(DOOMED))).rejects.toBeInstanceOf(
        RecentDocumentUnavailableError,
      );
      await db
        .update(userRecentDocuments)
        .set({ openedAt: new Date("2099-01-01T00:00:00.000Z") })
        .where(eq(userRecentDocuments.documentId, DOOMED));

      const liveIds = Array.from({ length: USER_RECENT_DOCUMENTS_CAP }, (_, index) =>
        id(0x2000 + index),
      );
      await db.insert(documents).values(
        liveIds.map((liveId, index) => ({
          id: liveId,
          contextSourceId: MANUSCRIPT,
          name: `live-${index}`,
          extension: "md",
        })),
      );
      for (const liveId of liveIds) {
        await repo.record(userId(USER), documentId(liveId));
      }

      const stored = await db
        .select({ documentId: userRecentDocuments.documentId })
        .from(userRecentDocuments)
        .where(eq(userRecentDocuments.userId, USER));
      expect(stored.map((row) => row.documentId).sort()).toEqual([...liveIds].sort());
      const listed = await repo.listByUser(userId(USER));
      expect(listed).toHaveLength(USER_RECENT_DOCUMENTS_CAP);
      expect(listed.map((item) => item.documentId)).not.toContain(DOOMED);
    });

    it("lists a binary document", async () => {
      const { repo } = await seed();
      await repo.record(userId(USER), documentId(PDF));
      await expect(repo.listByUser(userId(USER))).resolves.toEqual([
        expect.objectContaining({
          documentId: PDF,
          scheme: "manuscript",
          path: "/proof.pdf",
          name: "proof.pdf",
          filetype: "pdf",
          editable: false,
          workSlug: null,
        }),
      ]);
    });
  });
}
