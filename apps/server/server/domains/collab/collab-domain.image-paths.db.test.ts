/**
 * Document-link scopes across doors: images in search and in the model's read.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - one captured link scope per search operation
 */

import { createDb } from "@meridian/database";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import type { LoroDoc } from "loro-crdt";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantInProject, testFileGrant } from "../../test-support/file-grants.js";
import { grepQuery } from "../../test-support/grep-query.js";
import { treeListOfSource, treeSeeder } from "../../test-support/tree-seed.js";

import { ContextFS } from "../context/adapters/context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "../context/adapters/context-fs/drizzle-store.js";
import { createSourceTree } from "../context/adapters/context-fs/tree-writes.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "./test-support/document-link-scopes.js";
import { modelWrite } from "./test-support/model-write.js";
import {
  createWorkDraftFixture,
  DOC_ID,
  PROJECT_ID,
  SOURCE_ID,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_DRAFT_ID,
  WORK_ID,
} from "./test-support/work-draft-fixture.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab image paths (postgres)", () => {});
} else {
  describe("collab image paths (postgres)", () => {
    const db = createDb(DATABASE_URL, { max: 4 });
    const { createTestCollab, reset, dispose } = createWorkDraftFixture(db);
    beforeEach(reset);
    afterEach(dispose);
    afterAll(async () => {
      await db.$client.end();
    });
    const seeder = treeSeeder(db);
    const png = { storageKey: "test/map.png", mime: "image/png", size: 1 };
    const writes = createSourceTree({
      store: seeder.store,
      db,
      sourceId: async () => SOURCE_ID,
    });
    /** A live edit of the tree (rename, delete), as a person's would be. */
    async function liveEdit(edit: (writer: TreeWriter) => unknown) {
      await seeder.store.submit({
        lists: [await treeListOfSource(db, SOURCE_ID)],
        make: ([{ writer }]) => edit(writer),
      });
    }
    /** A chapter showing `assets/map.png`, and the model's grant in this project. */
    async function seedChapterWithMap(collab: ReturnType<typeof createTestCollab>) {
      await seeder.file(SOURCE_ID, "assets/map.png", png, {
        id: "00000000-0000-4000-8000-000000000712",
      });
      await writeMarkdown(collab, {
        documentId: DOC_ID as never,
        markdown: "Base.\n\n![Map](assets/map.png)",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      const grant = testFileGrant({ kind: "live" }, DOC_ID);
      await expect(
        modelWrite(
          collab.modelEdits(),
          {
            command: "insert",
            file: "chapter",
            documentId: DOC_ID,
            content: "![Pass](assets/map.png) The pass.",
          },
          {
            sessionId: "session-map",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            grant: grantInProject(grant, PROJECT_ID),
          },
          { accountId: USER_ID, projectId: PROJECT_ID },
        ),
      ).resolves.toMatchObject({ status: "success" });
    }

    // The adapter's snapshot reuse is pinned in `document-link-scope.db.test.ts`.
    it("shares search paths across chapters in a thread view", async () => {
      const links = createTestDocumentLinkScopes(db);
      const collab = createTestCollab(links);
      await seedChapterWithMap(collab);
      const secondDocumentId = "00000000-0000-4000-8000-000000000713";
      await seeder.document(SOURCE_ID, "chapter-two", { id: secondDocumentId });
      // Two uploads no path spells: a deleted cover whose path a new cover took,
      // and an id with no document behind it.
      const OLD_COVER = "00000000-0000-4000-8000-000000000718";
      const LOST = "00000000-0000-4000-8000-000000000719";
      await seeder.file(SOURCE_ID, "cover.png", png, { id: OLD_COVER });
      await liveEdit((writer) => writer.delete(LIVE, "system", OLD_COVER));
      await seeder.file(SOURCE_ID, "cover.png", png, {
        id: "00000000-0000-4000-8000-00000000071a",
      });
      await writeMarkdown(collab, {
        documentId: secondDocumentId as never,
        markdown: `See ![Map](assets/map.png), ![Old cover](asset:${OLD_COVER}) and ![Lost map](asset:${LOST}).`,
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      const assetsFolder = await seeder.folder(SOURCE_ID, "assets");
      let moveAfterRead = true;
      async function moveImage() {
        if (!moveAfterRead) return;
        moveAfterRead = false;
        await liveEdit((writer) => writer.rename(LIVE, "system", assetsFolder, "art"));
      }
      const context = new ContextFS({
        placement: { kind: "live" },
        holder: { projectId: PROJECT_ID },
        scheme: "manuscript",
        links,
        store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
        writes,
        actor: `user:${USER_ID}`,
        threadView: {
          threadId: THREAD_ID,
          draftOwner: {
            owner: { kind: "work", workId: WORK_ID as never },
            draftId: WORK_DRAFT_ID,
            handle: "w1",
          },
          writeMode: "direct",
        },
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
      const hits = await context.grep(grepQuery("Map"));
      expect(hits.ok).toBe(true);
      if (!hits.ok) throw new Error(JSON.stringify(hits.error));
      expect(hits.value.files).toHaveLength(2);
      for (const hit of hits.value.files) {
        expect(JSON.stringify(hit.matches)).toContain("assets/map.png");
        expect(JSON.stringify(hit.matches)).not.toContain("art/map.png");
        expect(JSON.stringify(hit.matches)).not.toMatch(/asset:|doc:/);
        // The capture records the upload's identity where the read showed it.
        expect(hit.shown?.passages.flat()).toContainEqual({
          ref: "asset:00000000-0000-4000-8000-000000000712",
          address: "manuscript://assets/map.png",
        });
      }
      const next = await context.grep(grepQuery("Map"));
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(JSON.stringify(next.error));
      expect(next.value.files).toHaveLength(2);
      for (const hit of next.value.files)
        expect(JSON.stringify(hit.matches)).toContain("art/map.png");
      const second = hits.value.files.find((hit) => hit.documentId === secondDocumentId);
      expect(JSON.stringify(second?.matches)).toContain(
        "![Old cover](manuscript://cover.png) and ![Lost map]()",
      );

      // The model's read spells them alike, and records the deleted cover where it showed it.
      const grant = testFileGrant({ kind: "live" }, secondDocumentId);
      const read = await collab.agentEdit().read(
        { file: "chapter-two", documentId: secondDocumentId },
        {
          sessionId: "session-read",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          grant: grantInProject(grant, PROJECT_ID),
        },
      );
      expect.soft(JSON.stringify(read.result), "model read").not.toMatch(/asset:|doc:/);
      expect
        .soft(JSON.stringify(read.result), "model read")
        .toContain("![Old cover](manuscript://cover.png) and ![Lost map]()");
      expect.soft(read.showing?.links, "read showing").toContainEqual({
        ref: `asset:${OLD_COVER}`,
        address: "manuscript://cover.png",
      });
    });
  });
}
