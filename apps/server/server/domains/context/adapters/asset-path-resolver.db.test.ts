/** A chapter's pictures follow their image documents through moves and deletes. */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createAllowAllFileAccess } from "../../file-policy/index.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("chapter image paths (postgres)", () => {});
} else {
  describe("chapter image paths (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { contextSources, documents, folders, projects, users } = await import(
      "@meridian/database/schema"
    );
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../collab/index.js");
    const { createDrizzleProjectWorkAuthorityResolver } = await import("../../projects/index.js");
    const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
      "../../../test-support/drizzle-reset.js"
    );
    const { createDrizzleDocumentAssetPaths } = await import("./asset-path-resolver.js");

    const USER_ID = "00000000-0000-4000-8000-000000000b01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000b02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000b03";
    const ASSETS_ID = "00000000-0000-4000-8000-000000000b04";
    const ART_ID = "00000000-0000-4000-8000-000000000b05";
    const CHAPTER_ID = "00000000-0000-4000-8000-000000000b06";
    const MAP_ID = "00000000-0000-4000-8000-000000000b07";
    const SEAL_ID = "00000000-0000-4000-8000-000000000b08";
    const STAMP_ID = "00000000-0000-4000-8000-000000000b09";
    const WRITER = { type: "user", actorUserId: USER_ID } as never;

    const db = createDb(DATABASE_URL, { max: 4 });
    const hocuspocus = {
      documents: new Map<string, Y.Doc>(),
      async openDirectConnection(name: string) {
        let document = hocuspocus.documents.get(name);
        if (!document) {
          document = new Y.Doc({ gc: false });
          hocuspocus.documents.set(name, document);
        }
        return { document, disconnect: async () => undefined };
      },
    };
    const collabs: Array<{ dispose(): void }> = [];
    afterEach(() => {
      for (const collab of collabs.splice(0)) collab.dispose();
    });

    function createCollab() {
      const collab = createCollabDomain({
        fileAccess: createAllowAllFileAccess(),
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        assetPaths: createDrizzleDocumentAssetPaths(db),
      });
      collab.bindHocuspocus(hocuspocus as never);
      collabs.push(collab);
      return collab;
    }

    async function save(collab: ReturnType<typeof createCollab>, markdown: string) {
      await collab.writeDocument({ documentId: CHAPTER_ID as never, markdown, origin: WRITER });
    }

    async function read(collab: ReturnType<typeof createCollab>): Promise<string> {
      const result = await collab.readAsMarkdown(CHAPTER_ID);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    }

    beforeEach(async () => {
      hocuspocus.documents.clear();
      await deleteDrizzleRows(db, [...DOCUMENT_RUNTIME_RESET_TABLES, projects, users]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "chapter-image-paths"));
      await db
        .insert(projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(folders).values([
        { id: ASSETS_ID, contextSourceId: SOURCE_ID, name: "assets" },
        { id: ART_ID, contextSourceId: SOURCE_ID, name: "art" },
      ]);
      const image = { contextSourceId: SOURCE_ID, extension: "png", fileType: "image" };
      await db.insert(documents).values([
        { id: CHAPTER_ID, contextSourceId: SOURCE_ID, name: "chapter", fileType: "markdown" },
        { ...image, id: MAP_ID, folderId: ASSETS_ID, name: "map", mimeType: "image/png" },
        { ...image, id: SEAL_ID, folderId: ASSETS_ID, name: "seal", mimeType: "image/png" },
      ]);
    });

    it("shows a moved image at its new path and a deleted one at its last", async () => {
      const collab = createCollab();
      await save(collab, "![Map](assets/map.png)\n\n![Seal](assets/seal.png)");

      await db.update(documents).set({ folderId: ART_ID }).where(eq(documents.id, MAP_ID));
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, SEAL_ID));

      expect(await read(collab)).toBe("![Map](art/map.png)\n\n![Seal](assets/seal.png)\n");
    });

    it("keeps a deleted image's reference through a writer save, even once its path is reused", async () => {
      const collab = createCollab();
      await save(collab, "![Map](assets/map.png)\n\n![Seal](assets/seal.png)");
      const deleted = new Date();
      await db.update(documents).set({ deletedAt: deleted }).where(eq(documents.id, MAP_ID));
      await db.update(documents).set({ deletedAt: deleted }).where(eq(documents.id, SEAL_ID));
      // A new image takes the deleted seal's path; the old seal must not read as it.
      await db.insert(documents).values({
        id: STAMP_ID,
        contextSourceId: SOURCE_ID,
        folderId: ASSETS_ID,
        name: "seal",
        extension: "png",
        fileType: "image",
        mimeType: "image/png",
      });

      const whileDeleted = await read(collab);
      expect(whileDeleted).toBe(`![Map](assets/map.png)\n\n![Seal](asset:${SEAL_ID})\n`);
      await save(collab, whileDeleted);

      await db.update(documents).set({ folderId: ART_ID }).where(eq(documents.id, STAMP_ID));
      await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, MAP_ID));
      await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, SEAL_ID));

      expect(await read(collab)).toBe("![Map](assets/map.png)\n\n![Seal](assets/seal.png)\n");
    });

    it("reads a written path outside assets/ as a reference to the image there", async () => {
      await db.update(documents).set({ folderId: ART_ID }).where(eq(documents.id, MAP_ID));
      const collab = createCollab();
      await save(collab, "![Map](art/map.png)");

      // Only a reference follows the image back; a literal path would stay put.
      await db.update(documents).set({ folderId: ASSETS_ID }).where(eq(documents.id, MAP_ID));

      expect(await read(collab)).toBe("![Map](assets/map.png)\n");
    });

    it("loads fresh for work that inherited a scope after it settled", async () => {
      const assetPaths = createDrizzleDocumentAssetPaths(db);
      let fire!: () => void;
      const timer = new Promise<void>((resolve) => {
        fire = resolve;
      });
      let later!: Promise<string | null>;
      await assetPaths.within({ documentId: CHAPTER_ID }, async () => {
        // Scheduled inside the operation, so it carries the operation's context.
        later = timer.then(() =>
          assetPaths.within({ documentId: CHAPTER_ID }, async () =>
            assetPaths.resolver.pathForAsset(MAP_ID),
          ),
        );
      });
      await db.update(documents).set({ folderId: ART_ID }).where(eq(documents.id, MAP_ID));
      fire();

      expect(await later).toBe("art/map.png");
    });

    it("keeps the enclosing paths for a nested call whose project isn't found", async () => {
      const assetPaths = createDrizzleDocumentAssetPaths(db);
      const unknownThread = "00000000-0000-4000-8000-000000000bff";

      const path = await assetPaths.within({ documentId: CHAPTER_ID }, () =>
        assetPaths.within({ threadId: unknownThread }, async () =>
          assetPaths.resolver.pathForAsset(MAP_ID),
        ),
      );

      expect(path).toBe("assets/map.png");
    });
  });
}
