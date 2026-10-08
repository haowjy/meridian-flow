/** Image-path scopes across draft review, Apply, and live reversal. */
import { createDb } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  documentBranches,
  documents,
  folders,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleDocumentAssetPaths } from "../context/adapters/asset-path-resolver.js";
import { ContextFS } from "../context/adapters/context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "../context/adapters/context-fs/drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "../context/adapters/context-fs/drizzle-tree-mutation-store.js";
import {
  createWorkDraftFixture,
  DOC_ID,
  DRAFT_DESTINATION,
  PROJECT_ID,
  SOURCE_ID,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/work-draft-fixture.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab image paths (postgres)", () => {});
} else {
  describe("collab image paths (postgres)", () => {
    const queries: string[] = [];
    const db = createDb(DATABASE_URL, {
      max: 4,
      postgres: {
        debug: (_connection, query) => {
          queries.push(query);
        },
      },
    });
    const { hocuspocus, createTestCollab, reset, dispose } = createWorkDraftFixture(db);
    beforeEach(reset);
    afterEach(dispose);
    afterAll(async () => {
      await db.$client.end();
    });
    /** The writer applies the document's Work draft (a draft write never pushes itself, D59). */
    async function applyDraft(
      collab: ReturnType<typeof createTestCollab>,
      documentId: string,
    ): Promise<void> {
      const [draft] = await db
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.documentId, documentId as never),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        );
      if (!draft) throw new Error(`missing Work draft for ${documentId}`);
      await collab.pushToLive({ branchId: draft.id, pushedByUserId: USER_ID as never });
    }

    async function currentDraftId(
      collab: ReturnType<typeof createTestCollab>,
      documentId: string,
    ): Promise<string> {
      const drafts = await collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
      });
      const draft = drafts.find((candidate) => candidate.documentId === documentId);
      if (!draft) throw new Error(`missing reviewable draft for ${documentId}`);
      return draft.draftId;
    }

    /** A chapter showing `assets/map.png`, and the model's grant in this project. */
    async function seedChapterWithMap(collab: ReturnType<typeof createTestCollab>) {
      const ASSETS_ID = "00000000-0000-4000-8000-000000000711";
      await db
        .insert(folders)
        .values({ id: ASSETS_ID, contextSourceId: SOURCE_ID, name: "assets" });
      await db.insert(documents).values({
        id: "00000000-0000-4000-8000-000000000712",
        contextSourceId: SOURCE_ID,
        folderId: ASSETS_ID,
        name: "map",
        extension: "png",
        fileType: "image",
        mimeType: "image/png",
      });
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.\n\n![Map](assets/map.png)",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      const grant = testFileGrant(DRAFT_DESTINATION, DOC_ID);
      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "![Pass](assets/map.png) The pass.",
          },
          {
            sessionId: "session-map",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            grant: { ...grant, facts: { ...grant.facts, projectId: PROJECT_ID as never } },
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
    }

    it.each([
      false,
      true,
    ])("shares search paths across chapters (thread view: %s)", async (threadView) => {
      const paths = createDrizzleDocumentAssetPaths(db);
      const collab = createTestCollab(paths);
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);
      const secondDocumentId = "00000000-0000-4000-8000-000000000713";
      await db.insert(documents).values({
        id: secondDocumentId,
        contextSourceId: SOURCE_ID,
        name: "chapter-two",
        extension: "md",
        fileType: "markdown",
      });
      await collab.writeDocument({
        documentId: secondDocumentId as never,
        markdown: "![Map](assets/map.png)",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      let moveAfterRead = true;
      async function moveImage() {
        if (!moveAfterRead) return;
        moveAfterRead = false;
        await db.update(folders).set({ name: "art" }).where(eq(folders.contextSourceId, SOURCE_ID));
      }
      const context = new ContextFS({
        scheme: "manuscript",
        assetPaths: paths,
        store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
        mutationStore: new DrizzleContextTreeMutationStore(db),
        ...(threadView
          ? {
              threadView: {
                threadId: THREAD_ID,
                draftWork: { id: WORK_ID as never, slug: "work" },
              },
            }
          : {}),
        documentSync: {
          ...collab,
          async readVersionedMarkdown(documentId) {
            const read = await collab.readVersionedMarkdown(documentId);
            await moveImage();
            return read;
          },
          async readEffectiveHashlines(command) {
            const read = await collab.readEffectiveHashlines(command);
            await moveImage();
            return read;
          },
        },
      });
      queries.length = 0;
      const hits = await context.search("map.png");
      expect(
        queries.filter((query) => query.includes("WITH RECURSIVE manuscript AS")),
      ).toHaveLength(1);
      expect(
        queries.filter((query) => query.includes("COALESCE(cs.project_id, w.project_id)")),
      ).toHaveLength(1);
      expect(hits.ok).toBe(true);
      if (!hits.ok) throw new Error(JSON.stringify(hits.error));
      expect(hits.value).toHaveLength(2);
      for (const hit of hits.value) {
        expect(JSON.stringify(hit.matches)).toContain("assets/map.png");
        expect(JSON.stringify(hit.matches)).not.toContain("art/map.png");
      }
      const next = await context.search("map.png");
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(JSON.stringify(next.error));
      expect(next.value).toHaveLength(2);
      for (const hit of next.value) expect(JSON.stringify(hit.matches)).toContain("art/map.png");
    });

    it("keeps one path snapshot when an image moves between preview serializations", async () => {
      const paths = createDrizzleDocumentAssetPaths(db);
      let moveAfterSerialization = false;
      const collab = createTestCollab({
        resolver: paths.resolver,
        within: (project, operation) =>
          paths.within(project, async () => {
            const result = await operation();
            // The engine's live serialization completes before preview reads the draft.
            if (moveAfterSerialization) {
              moveAfterSerialization = false;
              await db
                .update(folders)
                .set({ name: "art" })
                .where(eq(folders.contextSourceId, SOURCE_ID));
            }
            return result;
          }),
      });
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);
      const command = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        documentId: DOC_ID as never,
        draftId: await currentDraftId(collab, DOC_ID),
      };
      moveAfterSerialization = true;
      const preview = await collab.draftReview.preview(command);
      if (preview.status !== "active") throw new Error("missing draft preview");
      expect(preview.live).toContain("assets/map.png");
      expect(preview.markdown).toContain("assets/map.png");
      expect(preview.markdown).not.toContain("art/map.png");
      const next = await collab.draftReview.preview(command);
      if (next.status !== "active") throw new Error("missing draft preview");
      expect(next.live).toContain("art/map.png");
      expect(next.markdown).toContain("art/map.png");
    });

    it("accepts a draft on a chapter with an image", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);

      await expect(
        collab.draftReview.applyWorkDraft({
          projectId: PROJECT_ID as never,
          workId: WORK_ID as never,
          documentId: DOC_ID as never,
          draftId: await currentDraftId(collab, DOC_ID),
          userId: USER_ID as never,
        }),
      ).resolves.toMatchObject({ status: "applied" });

      const details = await db
        .select({ changes: changeTrailDocumentDetails.changes })
        .from(changeTrailDocumentDetails)
        .where(eq(changeTrailDocumentDetails.documentId, DOC_ID as never));
      // The trail keeps block text, which an image has none of; the push's
      // snapshot of every block is what serializes the picture.
      const trail = JSON.stringify(details);
      expect(trail).toContain("The pass.");
      expect(trail).not.toContain("asset:");
    });

    it("undoes and redoes a live turn on a chapter with an image", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);
      await applyDraft(collab, DOC_ID);

      for (const direction of ["undo", "redo"] as const) {
        const outcome = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction,
          actor: { type: "user", userId: USER_ID },
        });
        expect(outcome.status, JSON.stringify(outcome)).toBe("reversed");
        expect(JSON.stringify(outcome)).not.toContain("asset:");
      }
      await expectMarkdown(collab, DOC_ID, "![Pass](assets/map.png) The pass.");
    });
  });
}
async function expectMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
  expected: string,
) {
  const read = await collab.readAsMarkdown(documentId);
  expect(read.ok ? read.value : "").toContain(expected);
}
