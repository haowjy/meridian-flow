/** ContextFS Drizzle-store shadow observer behavior. */
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, folders, projects, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import {
  type ContextDocumentMembershipObserver,
  DrizzleContextDocumentStore,
  DrizzleContextTreeMutationStore,
  notifyMembershipObserver,
} from "./drizzle-store.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

describe("notifyMembershipObserver", () => {
  it("keeps shadow membership failures off the user operation path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        notifyMembershipObserver(
          {
            documentCreated: () => {
              throw new Error("shadow failed");
            },
            documentDeleted: () => undefined,
          },
          "documentCreated",
          "doc-1",
        ),
      ).not.toThrow();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });
});

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("ContextFS Drizzle membership dispatch (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("ContextFS Drizzle membership dispatch (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
    const DOC_CREATE_ID = "00000000-0000-4000-8000-000000000704";
    const DOC_DELETE_ID = "00000000-0000-4000-8000-000000000705";
    const DOC_MOVE_SOURCE_ID = "00000000-0000-4000-8000-000000000706";
    const DOC_MOVE_TARGET_ID = "00000000-0000-4000-8000-000000000707";
    const DOC_ROLLBACK_SOURCE_ID = "00000000-0000-4000-8000-000000000708";
    const DOC_ROLLBACK_TARGET_ID = "00000000-0000-4000-8000-000000000709";
    const DOC_AMBIENT_DELETE_ID = "00000000-0000-4000-8000-000000000710";

    const db = createDb(DATABASE_URL, { max: 4 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [documents, folders, contextSources, projects, users]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "contextfs-dispatch"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "ContextFS Dispatch Project",
        slug: "contextfs-dispatch-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    async function insertDocument(id: string, name: string) {
      await db.insert(documents).values({
        id,
        contextSourceId: SOURCE_ID,
        name,
        extension: "md",
        fileType: "markdown",
        markdownProjection: name,
      });
    }

    it("does not dispatch overwrite-delete membership events when the later source move rolls back", async () => {
      await insertDocument(DOC_ROLLBACK_SOURCE_ID, "rollback-source");
      await insertDocument(DOC_ROLLBACK_TARGET_ID, "rollback-target");
      const observer = {
        documentCreated: vi.fn(),
        documentDeleted: vi.fn(),
      } satisfies ContextDocumentMembershipObserver;
      const tree = new DrizzleContextTreeMutationStore(db, observer);
      const source = await tree.inspect(SOURCE_ID, "rollback-source.md");
      const target = await tree.inspect(SOURCE_ID, "rollback-target.md");
      expect(source?.kind).toBe("file");
      expect(target?.kind).toBe("file");

      let destructiveWrites = 0;
      tree.setBeforeDestructiveWrite(async () => {
        destructiveWrites += 1;
        if (destructiveWrites === 2) {
          await db
            .update(documents)
            .set({ updatedAt: new Date("2030-01-01T00:00:00.000Z") })
            .where(eq(documents.id, DOC_ROLLBACK_SOURCE_ID));
        }
      });

      const result = await tree.commitMove({
        source: source as Extract<NonNullable<typeof source>, { kind: "file" }>,
        destinationSourceId: SOURCE_ID,
        destinationPath: "rollback-target.md",
        expectedTarget: {
          state: "occupied",
          token: target as Extract<NonNullable<typeof target>, { kind: "file" }>,
        },
        overwrite: true,
      });
      const [targetAfter] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, DOC_ROLLBACK_TARGET_ID));

      expect(result).toEqual({ ok: false, error: { code: "stale_source" } });
      expect(targetAfter?.deletedAt).toBeNull();
      expect(observer.documentDeleted).not.toHaveBeenCalled();
    });

    it("dispatches create, delete, and overwrite-move membership events exactly once after commit", async () => {
      await insertDocument(DOC_DELETE_ID, "delete-me");
      await insertDocument(DOC_MOVE_SOURCE_ID, "move-source");
      await insertDocument(DOC_MOVE_TARGET_ID, "move-target");
      const events: string[] = [];
      const observerWork: Promise<void>[] = [];
      const observer: ContextDocumentMembershipObserver = {
        documentCreated(documentId) {
          events.push(`created:${documentId}`);
        },
        documentDeleted(documentId) {
          events.push(`deleted:${documentId}`);
          const work = (async () => {
            const [row] = await db
              .select({ deletedAt: documents.deletedAt })
              .from(documents)
              .where(eq(documents.id, documentId));
            expect(row?.deletedAt).toBeInstanceOf(Date);
          })();
          observerWork.push(work);
          return work;
        },
      };
      const contentStore = new DrizzleContextDocumentStore({
        db,
        contextSourceId: SOURCE_ID,
        membershipObserver: observer,
      });
      const tree = new DrizzleContextTreeMutationStore(db, observer);

      await contentStore.upsertDocument({
        id: DOC_CREATE_ID,
        folderId: null,
        name: "created",
        extension: "md",
        markdown: "created",
        filetype: "markdown",
      });
      const deleteToken = await tree.inspect(SOURCE_ID, "delete-me.md");
      expect(deleteToken?.kind).toBe("file");
      await expect(
        tree.commitDelete(deleteToken as NonNullable<typeof deleteToken>),
      ).resolves.toEqual({
        ok: true,
        value: { deletedNodeId: DOC_DELETE_ID },
      });
      const moveSource = await tree.inspect(SOURCE_ID, "move-source.md");
      const moveTarget = await tree.inspect(SOURCE_ID, "move-target.md");
      expect(moveSource?.kind).toBe("file");
      expect(moveTarget?.kind).toBe("file");
      await expect(
        tree.commitMove({
          source: moveSource as Extract<NonNullable<typeof moveSource>, { kind: "file" }>,
          destinationSourceId: SOURCE_ID,
          destinationPath: "move-target.md",
          expectedTarget: {
            state: "occupied",
            token: moveTarget as Extract<NonNullable<typeof moveTarget>, { kind: "file" }>,
          },
          overwrite: true,
        }),
      ).resolves.toEqual({ ok: true, value: { movedNodeId: DOC_MOVE_SOURCE_ID } });
      await Promise.all(observerWork);

      expect(events).toEqual([
        `created:${DOC_CREATE_ID}`,
        `deleted:${DOC_DELETE_ID}`,
        `deleted:${DOC_MOVE_TARGET_ID}`,
      ]);
    });

    it("dispatches tree-mutation observers from a root connection instead of joining ambient transactions", async () => {
      await insertDocument(DOC_AMBIENT_DELETE_ID, "ambient-delete");
      let observerSawRootConnection = false;
      const observer: ContextDocumentMembershipObserver = {
        documentCreated: () => undefined,
        documentDeleted: () => {
          observerSawRootConnection = currentDrizzleDb(db) === db;
        },
      };
      const tree = new DrizzleContextTreeMutationStore(db, observer);
      const token = await tree.inspect(SOURCE_ID, "ambient-delete.md");
      expect(token?.kind).toBe("file");

      await runInDrizzleTransaction(db, async () => {
        await expect(tree.commitDelete(token as NonNullable<typeof token>)).resolves.toEqual({
          ok: true,
          value: { deletedNodeId: DOC_AMBIENT_DELETE_ID },
        });
      });

      expect(observerSawRootConnection).toBe(true);
    });
  });
}
