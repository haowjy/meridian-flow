/** Postgres proof for the tree view: the live and draft relations, identity status and tree state. */
import type { DocumentId, FolderId } from "@meridian/contracts";
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import { documents, drafts, draftTreeChanges, folders, users } from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createDrizzleDraftStore } from "../../collab/adapters/drizzle-drafts.js";
import {
  createTreeReader,
  LIVE_TREE,
  type TreeView,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
} from "./tree-view.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("tree view (postgres)", () => {});
} else {
  describe("tree view (postgres)", () => {
    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    async function folderId(name: string): Promise<FolderId> {
      const [row] = await database.current
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.name, name));
      if (!row) throw new Error(`No folder ${name}`);
      return row.id;
    }

    /** The live tree takes a drafted create in: reveal it (and its folders), as Apply will. */
    async function reveal(id: DocumentId, folderNames: readonly string[] = []) {
      const db = database.current;
      await db.update(documents).set({ hidden: false }).where(eq(documents.id, id));
      if (folderNames.length > 0) {
        await db.update(folders).set({ hidden: false }).where(inArray(folders.name, folderNames));
      }
    }

    async function softDelete(id: DocumentId, folderNames: readonly string[] = []) {
      const db = database.current;
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, id));
      if (folderNames.length > 0) {
        await db
          .update(folders)
          .set({ deletedAt: new Date() })
          .where(inArray(folders.name, folderNames));
      }
    }

    async function idsIn(view: TreeView) {
      const db = database.current;
      const vd = visibleDocuments(view);
      const vf = visibleFolders(view);
      return {
        documents: (await db.select({ id: vd.id }).from(vd)).map((row) => row.id).sort(),
        folders: (await db.select({ name: vf.name }).from(vf)).map((row) => row.name).sort(),
      };
    }

    it("shows hidden rows only in the draft that created them, at their rows' locations (T-1a)", async () => {
      const db = database.current;
      const scenario = await draftTreeScenario(db);
      const tree = createTreeReader(db);
      const manuscript = scenario.project.sources.manuscript;
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");

      const kael = await scenario.seedLive("world/kael");
      const prologue = await scenario.seedLive("prologue");
      const harbor = await scenario.seedHidden(ascension, "world/places/harbor");
      const atlas = await scenario.seedHidden(rival, "lore/atlas");
      // Revealed, then renamed live: the draft sees the new name too, a row has one place.
      const chapter = await scenario.seedHidden(ascension, "chapters/one");
      await reveal(chapter, ["chapters"]);
      await db.update(documents).set({ name: "chapter-one" }).where(eq(documents.id, chapter));
      // A live absorb reparents a second hidden document onto the first one's address.
      const notes = await scenario.seedHidden(ascension, "drafts/notes");
      const scraps = await scenario.seedHidden(ascension, "scraps/notes");
      await db
        .update(documents)
        .set({ folderId: await folderId("drafts") })
        .where(eq(documents.id, scraps));

      const draft: TreeView = {
        kind: "draft",
        draftId: (await scenario.draftOf(ascension)).id,
      };

      expect(await idsIn(LIVE_TREE)).toEqual({
        documents: [kael, prologue, chapter].sort(),
        folders: ["chapters", "world"],
      });
      expect(await idsIn(draft)).toEqual({
        documents: [kael, prologue, harbor, chapter, notes, scraps].sort(),
        folders: ["chapters", "drafts", "places", "world"],
      });
      expect(
        (
          await db.execute<{ id: string }>(
            sql`SELECT d.id::text AS id FROM ${visibleDocumentsSql(draft)} d ORDER BY d.id`,
          )
        ).map((row) => row.id),
      ).toEqual([kael, prologue, harbor, chapter, notes, scraps].sort());

      const at = (path: string) => ({ contextSourceId: manuscript, path });
      expect(await tree.resolvePath(LIVE_TREE, at("world/places/harbor"))).toEqual({
        kind: "not_found",
      });
      expect(await tree.findById(LIVE_TREE, harbor)).toEqual({ kind: "not_found" });
      expect(await tree.findById(LIVE_TREE, atlas)).toEqual({ kind: "not_found" });
      expect(await tree.resolvePath(LIVE_TREE, at("world/kael"))).toMatchObject({
        kind: "found",
        node: { kind: "document", document: { id: kael, path: "world/kael", hidden: false } },
      });
      expect(await tree.resolvePath(LIVE_TREE, at("chapters/chapter-one"))).toMatchObject({
        kind: "found",
        node: { document: { id: chapter } },
      });

      expect(await tree.resolvePath(draft, at("world/places/harbor"))).toMatchObject({
        kind: "found",
        node: { document: { id: harbor, hidden: true, path: "world/places/harbor" } },
      });
      expect(await tree.findById(draft, chapter)).toMatchObject({
        kind: "found",
        document: { path: "chapters/chapter-one", hidden: false },
        clashesWith: [],
      });
      expect(await tree.resolvePath(draft, at("chapters/one"))).toEqual({ kind: "not_found" });
      expect(await tree.findFolderById(draft, await folderId("places"))).toMatchObject({
        name: "places",
        hidden: true,
        path: "world/places",
      });
      expect(await tree.findFolderById(LIVE_TREE, await folderId("places"))).toBeNull();
      expect(await tree.findFolderById(draft, await folderId("lore"))).toBeNull();

      const ambiguous = await tree.resolvePath(draft, at("drafts/notes"));
      expect(ambiguous.kind).toBe("ambiguous");
      expect(
        ambiguous.kind === "ambiguous" && ambiguous.nodes.map((node) => node.id).sort(),
      ).toEqual([notes, scraps].sort());
      expect(await tree.findById(draft, notes)).toMatchObject({ clashesWith: [scraps] });

      // Two storage tuples that render one filename hold one path, by path and by id.
      // (Not a canonical pair: a raw row from before the name codec, kept by the reader.)
      const [dottedRow, literal] = await db
        .insert(documents)
        .values([
          { contextSourceId: manuscript, name: "same", extension: "md" },
          { contextSourceId: manuscript, name: "same.md", extension: "" },
        ])
        .returning({ id: documents.id });
      if (!dottedRow || !literal) throw new Error("Same-filename documents were not inserted");
      const dotted = dottedRow.id;
      const same = await tree.resolvePath(LIVE_TREE, at("same.md"));
      expect(same.kind === "ambiguous" && same.nodes.map((node) => node.id).sort()).toEqual(
        [dotted, literal.id].sort(),
      );
      expect(await tree.findById(LIVE_TREE, dotted)).toMatchObject({ clashesWith: [literal.id] });
      expect(await tree.findById(draft, literal.id)).toMatchObject({ clashesWith: [dotted] });
    });

    it("names identity per view and states a draft's tree with its conflicts (T-1b)", async () => {
      const db = database.current;
      const scenario = await draftTreeScenario(db);
      const tree = createTreeReader(db);
      const store = createDrizzleDraftStore(db);
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");
      const stray = await scenario.work("Stray", "draft");

      const harbor = await scenario.seedHidden(ascension, "world/harbor");
      const first = await scenario.draftOf(ascension);
      const second = await scenario.draftOf(rival);
      const third = await scenario.draftOf(stray);
      // Rival joined the harbor too; Ascension is the older draft.
      await db.insert(draftTreeChanges).values({
        draftId: second.id,
        nodeKind: "document",
        nodeId: harbor,
        created: true,
      });
      await db
        .update(drafts)
        .set({ createdAt: sql`now() - interval '2 hours'` })
        .where(eq(drafts.id, first.id));
      await db
        .update(drafts)
        .set({ createdAt: sql`now() - interval '1 hour'` })
        .where(eq(drafts.id, second.id));

      const ledger = await scenario.seedLive("old/ledger");
      await softDelete(ledger, ["old"]);
      const tomb = await scenario.seedHidden(ascension, "tomb");
      await softDelete(tomb);
      const orphan = await scenario.seedHidden(stray, "orphan");
      await store.close(third.id, new Date());
      const missing = "00000000-0000-4000-8000-00000000dead" as DocumentId;

      const root = await scenario.seedLive("root");
      const ids = [harbor, ledger, tomb, orphan, missing];
      const liveLineages = await tree.lineages(LIVE_TREE, [...ids, root, root]);
      expect([...liveLineages.keys()].sort()).toEqual([ledger, root].sort());
      expect(liveLineages.get(root)).toMatchObject({ status: "visible", folders: [] });
      expect(liveLineages.get(ledger)).toMatchObject({
        status: "deleted",
        folders: [{ id: await folderId("old"), deleted: true }],
      });
      const draftLineages = await tree.lineages({ kind: "draft", draftId: first.id }, ids);
      expect([...draftLineages.keys()].sort()).toEqual([harbor, ledger].sort());
      expect(draftLineages.get(harbor)).toMatchObject({
        status: "visible",
        folders: [{ id: await folderId("world"), deleted: false }],
      });
      expect(await tree.lineages(LIVE_TREE, [])).toEqual(new Map());

      const live = await tree.identityStatus(LIVE_TREE, ids);
      expect(live.get(harbor)).toMatchObject({
        kind: "hidden",
        draft: { draftId: first.id, originWorkId: ascension.id },
        usedBy: [{ draftId: first.id }, { draftId: second.id }],
        address: { path: "world/harbor", uri: "manuscript://world/harbor" },
      });
      expect(live.get(ledger)).toMatchObject({
        kind: "deleted",
        lastAddress: { path: "old/ledger" },
      });
      expect(live.get(tomb)).toEqual({ kind: "gone", documentId: tomb });
      expect(live.get(orphan)).toEqual({ kind: "gone", documentId: orphan });
      expect(live.get(missing)).toEqual({ kind: "gone", documentId: missing });
      const rivalView = await tree.identityStatus({ kind: "draft", draftId: second.id }, ids);
      expect(rivalView.get(harbor)).toMatchObject({
        kind: "visible",
        hidden: true,
        address: { path: "world/harbor" },
      });
      expect(rivalView.get(tomb)).toEqual({ kind: "gone", documentId: tomb });
      expect(
        (await tree.identityStatus({ kind: "draft", draftId: third.id }, [harbor])).get(harbor),
      ).toMatchObject({ kind: "hidden", draft: { draftId: first.id } });

      // Tree state: every item at its row's location.
      const liveIntro = await scenario.seedLive("intro");
      const intro = await scenario.seedHidden(ascension, "intro");
      const coast = await scenario.seedHidden(ascension, "maps/coast");
      const maps = await scenario.seedLive("maps");
      const chapter = await scenario.seedHidden(ascension, "chapters/one");
      await reveal(chapter, ["chapters"]);
      await db.update(documents).set({ name: "chapter-one" }).where(eq(documents.id, chapter));
      const scene = await scenario.seedHidden(ascension, "gone/scene");
      await reveal(scene, ["gone"]);
      await softDelete(scene, ["gone"]);
      const arc = await scenario.seedLive("arc/two");
      await softDelete(arc, ["arc"]);
      // Deleted with its folder; a new live folder of that name now holds its path.
      const replaced = await scenario.seedLive("saga/three");
      await softDelete(replaced, ["saga"]);
      const occupant = await scenario.seedLive("saga/three");
      const tale = await scenario.seedLive("tale/four");
      await softDelete(tale, ["tale"]);
      const taleFolder = await scenario.seedLiveFolder("tale/four");
      const quiet = await scenario.seedLive("notes");

      const state = new Map(
        (await tree.treeState(first.id, [arc, replaced, tale, quiet, harbor])).map((node) => [
          node.nodeId,
          node,
        ]),
      );
      expect([...state.keys()].sort()).toEqual(
        [harbor, intro, coast, chapter, scene, arc, replaced, tale, quiet].sort(),
      );
      expect(state.get(harbor)).toMatchObject({
        origin: "created",
        hidden: true,
        binary: false,
        target: { path: "world/harbor" },
        conflict: { kind: "none" },
      });
      expect(state.get(intro)?.conflict).toEqual({
        kind: "clash",
        withNode: { kind: "document", id: liveIntro },
        at: "intro",
        uri: "manuscript://intro",
      });
      expect(state.get(coast)?.conflict).toEqual({
        kind: "clash",
        withNode: { kind: "document", id: maps },
        at: "maps",
        uri: "manuscript://maps",
      });
      expect(state.get(chapter)).toMatchObject({
        hidden: false,
        deleted: false,
        target: { path: "chapters/chapter-one", uri: "manuscript://chapters/chapter-one" },
        conflict: { kind: "none" },
      });
      expect(state.get(scene)).toMatchObject({
        origin: "created",
        deleted: true,
        conflict: { kind: "deleted_live" },
      });
      expect(state.get(arc)).toMatchObject({
        origin: "edited",
        deleted: true,
        target: { path: "arc/two" },
        conflict: { kind: "deleted_live" },
      });
      expect(state.get(replaced)?.conflict).toEqual({
        kind: "clash",
        withNode: { kind: "document", id: occupant },
        at: "saga/three",
        uri: "manuscript://saga/three",
      });
      expect(state.get(tale)?.conflict).toEqual({
        kind: "clash",
        withNode: { kind: "folder", id: taleFolder },
        at: "tale/four",
        uri: "manuscript://tale/four",
      });
      expect(state.get(quiet)).toMatchObject({ origin: "edited", conflict: { kind: "none" } });
      // A tombstone is no longer the draft's item.
      expect(state.has(tomb)).toBe(false);
      expect(
        await db
          .select({ id: draftTreeChanges.nodeId })
          .from(draftTreeChanges)
          .where(and(eq(draftTreeChanges.draftId, first.id), eq(draftTreeChanges.nodeId, tomb))),
      ).toHaveLength(1);
    });
  });
}
