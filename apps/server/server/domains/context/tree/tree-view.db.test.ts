/** Postgres proof for the tree view: the live and branch relations, identity status and tree state. */
import type { BranchId, DocumentId, FolderId } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  branchTreeChanges,
  branchTreeFolders,
  documents,
  folders,
  users,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { branchTreeScenario } from "../../../test-support/branch-tree-scenario.js";
import { createTestDocumentRemoval } from "../../../test-support/document-removal.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createDrizzleBranchStore } from "../../collab/adapters/drizzle-branches.js";
import { deleteInBranch, moveInBranch } from "./branch-tree-changes.js";
import { absorbAt, resolveAbsorbedFolders } from "./folder-normalization.js";
import {
  createTreeReader,
  LIVE_TREE,
  type TreeView,
  visibleDocuments,
  visibleDocumentsSql,
  visibleFolders,
} from "./tree-view.js";
import {
  isUnusedHiddenFolder,
  loadHiddenDocumentCandidates,
  loadPendingDocumentIds,
} from "./tree-view-sql.js";

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
      await db
        .update(documents)
        .set({ deletionReason: "deleted", deletedAt: new Date() })
        .where(eq(documents.id, id));
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

    it("shows hidden rows only in the branch that created them, at their rows' locations (T-1a)", async () => {
      const db = database.current;
      const scenario = await branchTreeScenario(db);
      const tree = createTreeReader(db);
      const manuscript = scenario.project.sources.manuscript;
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");

      const kael = await scenario.seedLive("world/kael");
      const prologue = await scenario.seedLive("prologue");
      const harbor = await scenario.seedHidden(ascension, "world/places/harbor");
      const atlas = await scenario.seedHidden(rival, "lore/atlas");
      // Revealed, then renamed live: the branch sees the new name too, a row has one place.
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

      const branch: TreeView = {
        kind: "branch",
        branchId: (await scenario.branchOf(ascension)).id,
      };

      expect(await idsIn(LIVE_TREE)).toEqual({
        documents: [kael, prologue, chapter].sort(),
        folders: ["chapters", "world"],
      });
      expect(await idsIn(branch)).toEqual({
        documents: [kael, prologue, harbor, chapter, notes, scraps].sort(),
        folders: ["chapters", "drafts", "places", "world"],
      });
      expect(
        (
          await db.execute<{ id: string }>(
            sql`SELECT d.id::text AS id FROM ${visibleDocumentsSql(branch)} d ORDER BY d.id`,
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

      expect(await tree.resolvePath(branch, at("world/places/harbor"))).toMatchObject({
        kind: "found",
        node: { document: { id: harbor, hidden: true, path: "world/places/harbor" } },
      });
      expect(await tree.findById(branch, chapter)).toMatchObject({
        kind: "found",
        document: { path: "chapters/chapter-one", hidden: false },
        clashesWith: [],
      });
      expect(await tree.resolvePath(branch, at("chapters/one"))).toEqual({ kind: "not_found" });
      expect(await tree.findFolderById(branch, await folderId("places"))).toMatchObject({
        name: "places",
        hidden: true,
        path: "world/places",
      });
      expect(await tree.findFolderById(LIVE_TREE, await folderId("places"))).toBeNull();
      expect(await tree.findFolderById(branch, await folderId("lore"))).toBeNull();

      const ambiguous = await tree.resolvePath(branch, at("drafts/notes"));
      expect(ambiguous.kind).toBe("ambiguous");
      expect(
        ambiguous.kind === "ambiguous" && ambiguous.nodes.map((node) => node.id).sort(),
      ).toEqual([notes, scraps].sort());
      expect(await tree.findById(branch, notes)).toMatchObject({ clashesWith: [scraps] });

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
      expect(await tree.findById(branch, literal.id)).toMatchObject({ clashesWith: [dotted] });
    });

    /** One branch's drafted tree writes, and how the branch view shows them. */
    async function drafting(scenario: Awaited<ReturnType<typeof branchTreeScenario>>) {
      const db = database.current;
      const tree = createTreeReader(db);
      const { manuscript } = scenario.project.sources;
      const ascension = await scenario.work("Ascension", "draft");
      const branchId = (await scenario.branchOf(ascension)).id as BranchId;
      const view: TreeView = { kind: "branch", branchId };
      return {
        ascension,
        branchId,
        view,
        move(documentId: DocumentId, path: string, contextSourceId = manuscript) {
          const segments = path.split("/");
          const parsed = parseDocumentFilename(segments.pop() ?? "");
          if (!parsed.ok) throw new Error(parsed.error.message);
          const { name, extension } = parsed.value;
          return moveInBranch(db, {
            branchId,
            documentId,
            to: { contextSourceId, dir: segments, name, extension },
            changedBy: null,
          });
        },
        remove: (documentId: DocumentId) =>
          deleteInBranch(db, { branchId, documentId, changedBy: null }),
        async shownAt(path: string, contextSourceId = manuscript) {
          const found = await tree.resolvePath(view, { contextSourceId, path });
          return found.kind === "found"
            ? (found.node as { document?: { id: string } }).document?.id
            : found.kind;
        },
        pending: async (...ids: DocumentId[]) =>
          [...(await loadPendingDocumentIds(db, branchId, ids))].sort(),
      };
    }

    it("shows each fact of a branch's drafted moves and deletes against each live state (PR 3)", async () => {
      const db = database.current;
      const scenario = await branchTreeScenario(db);
      const tree = createTreeReader(db);
      const { manuscript, kb, unfiled } = scenario.project.sources;
      const { ascension, view, move, remove, shownAt, pending } = await drafting(scenario);
      const rival = await scenario.work("Rival", "draft");
      const kernel = createTestDocumentRemoval(db);
      const removal = {
        remove: (input: Parameters<typeof kernel.remove>[0]) =>
          runInDrizzleTransaction(db, () => kernel.remove(input)),
      };

      const ch1 = await scenario.seedLive("book/ch1");
      const ch2 = await scenario.seedLive("book/ch2");
      const ch3 = await scenario.seedLive("ch3");
      // A taken name in the branch's view lands beside it; once vacated, the exact name is free.
      expect(await move(ch1, "book/ch2")).toMatchObject({
        ok: true,
        value: { after: { moved: { name: "ch2 (2)" } } },
      });
      expect((await move(ch2, "book/ch2b")).ok).toBe(true);
      expect((await move(ch1, "book/ch2")).ok).toBe(true);
      expect(await shownAt("book/ch1")).toBe("not_found");
      // A live rename of the destination folder shows in the branch (D80).
      await db
        .update(folders)
        .set({ name: "volume" })
        .where(eq(folders.id, await folderId("book")));
      expect(await shownAt("volume/ch2")).toBe(ch1);
      expect(await pending(ch1, ch2)).toEqual([ch1, ch2].sort());

      // A drafted move into kb takes kb's grants; a live move of its folder into another
      // source carries it.
      expect((await move(ch2, "lore/ch2", kb)).ok).toBe(true);
      expect((await tree.lineage(view, ch2))?.contextSourceId).toBe(kb);
      expect((await tree.lineage(LIVE_TREE, ch2))?.contextSourceId).toBe(manuscript);
      await db
        .update(folders)
        .set({ contextSourceId: unfiled })
        .where(eq(folders.id, await folderId("lore")));
      expect((await tree.lineage(view, ch2))?.contextSourceId).toBe(unfiled);
      expect(await shownAt("lore/ch2", unfiled)).toBe(ch2);

      // A move back to its row's place is no change to review, and the row stays.
      expect((await move(ch3, "drafts/ch3")).ok).toBe(true);
      expect((await move(ch3, "ch3")).ok).toBe(true);
      expect(await pending(ch3)).toEqual([]);
      expect(await shownAt("ch3")).toBe(ch3);

      // deleting × living: pending, invisible, deleted in the branch's identity.
      expect((await remove(ch1)).ok).toBe(true);
      expect(await pending(ch1)).toEqual([ch1]);
      expect(await shownAt("volume/ch2")).toBe("not_found");
      expect((await tree.identityStatus(view, [ch1])).get(ch1)).toMatchObject({ kind: "deleted" });
      // A writer's live delete keeps the facts: deleting × deleted is nothing pending.
      await removal.remove({
        documentIds: [ch1],
        reason: "deleted",
        userId: scenario.project.userId,
      });
      expect(
        (await db.select().from(branchTreeChanges).where(eq(branchTreeChanges.nodeId, ch1)))[0],
      ).toMatchObject({ deleted: true, moved: true });
      expect(await pending(ch1)).toEqual([]);
      // The model's live delete keeps a moved-only proposal: moving × deleted restores it.
      await removal.remove({ documentIds: [ch2], reason: "deleted", threadId: ascension.threadId });
      expect(await pending(ch2)).toEqual([ch2]);
      expect(await shownAt("lore/ch2", unfiled)).toBe(ch2);

      // created × hidden, created+deleted × hidden, created+moved × hidden.
      const fresh = await scenario.seedHidden(ascension, "fresh");
      expect(await pending(fresh)).toEqual([fresh]);
      expect((await remove(fresh)).ok).toBe(true);
      expect(await pending(fresh)).toEqual([]);
      expect(await shownAt("fresh")).toBe("not_found");
      const sketch = await scenario.seedHidden(ascension, "sketch");
      expect((await move(sketch, "sketch-2")).ok).toBe(true);
      expect(await pending(sketch)).toEqual([sketch]);
      expect(await shownAt("sketch-2")).toBe(sketch);
      // A shared creation another branch revealed: deleting it is pending.
      const shared = await scenario.seedHidden(rival, "shared");
      await scenario.seedHidden(ascension, "shared", { join: shared });
      await reveal(shared);
      expect(await pending(shared)).toEqual([shared]);
      expect((await remove(shared)).ok).toBe(true);
      expect(await pending(shared)).toEqual([shared]);
    });

    it("keeps a drafted move into a hidden folder whole when a live folder absorbs it (PR 3)", async () => {
      const db = database.current;
      const scenario = await branchTreeScenario(db);
      const { branchId, view, move, shownAt } = await drafting(scenario);
      const ch3 = await scenario.seedLive("ch3");

      // A move into folders that don't exist makes hidden ones only the branch sees, held
      // against pruning.
      expect((await move(ch3, "drafts/ch3")).ok).toBe(true);
      const hidden = await folderId("drafts");
      expect(await isUnusedHiddenFolder(db, hidden)).toBe(false);
      expect((await idsIn(LIVE_TREE)).folders).not.toContain("drafts");
      expect((await idsIn(view)).folders).toContain("drafts");

      // A live folder arriving at its path absorbs it: the fact, the hold and every recorded
      // placement naming it follow the live folder, so the move's history still matches.
      await db.update(folders).set({ name: "drafts-hidden" }).where(eq(folders.id, hidden));
      const live = await scenario.seedLiveFolder("drafts");
      await db.update(folders).set({ name: "drafts" }).where(eq(folders.id, hidden));
      await absorbAt(db, live);
      expect(
        (await db.select().from(branchTreeChanges).where(eq(branchTreeChanges.nodeId, ch3)))[0],
      ).toMatchObject({ movedFolderId: live });
      expect(
        await db.select().from(branchTreeFolders).where(eq(branchTreeFolders.branchId, branchId)),
      ).toEqual([{ branchId, documentId: ch3, folderId: live }]);
      expect(await resolveAbsorbedFolders(db, [hidden, live])).toEqual(
        new Map([
          [hidden, live],
          [live, live],
        ]),
      );
      expect(await shownAt("drafts/ch3")).toBe(ch3);
    });

    it("lets a create join a hidden candidate only while no branch using it moved it away (PR 3)", async () => {
      const db = database.current;
      const scenario = await branchTreeScenario(db);
      const { ascension, move } = await drafting(scenario);
      const rival = await scenario.work("Rival", "draft");
      const atlas = await scenario.seedHidden(rival, "atlas");
      const [row] = await db.select().from(documents).where(eq(documents.id, atlas));
      const at = {
        contextSourceId: scenario.project.sources.manuscript,
        folderId: null,
        name: "atlas",
        extension: row?.extension ?? "",
      };
      expect((await loadHiddenDocumentCandidates(db, at)).map((candidate) => candidate.id)).toEqual(
        [atlas],
      );
      await scenario.seedHidden(ascension, "atlas", { join: atlas });
      expect((await move(atlas, "atlas-moved")).ok).toBe(true);
      expect(await loadHiddenDocumentCandidates(db, at)).toEqual([]);
    });

    it("names identity per view and states a branch's tree with its conflicts (T-1b)", async () => {
      const db = database.current;
      const scenario = await branchTreeScenario(db);
      const tree = createTreeReader(db);
      const store = createDrizzleBranchStore(db);
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");
      const stray = await scenario.work("Stray", "draft");

      const harbor = await scenario.seedHidden(ascension, "world/harbor");
      const first = await scenario.branchOf(ascension);
      const second = await scenario.branchOf(rival);
      const third = await scenario.branchOf(stray);
      // Rival joined the harbor too; Ascension is the older branch.
      await db.insert(branchTreeChanges).values({
        branchId: second.id,
        nodeKind: "document",
        nodeId: harbor,
        created: true,
      });
      await db
        .update(branches)
        .set({ createdAt: sql`now() - interval '2 hours'` })
        .where(eq(branches.id, first.id));
      await db
        .update(branches)
        .set({ createdAt: sql`now() - interval '1 hour'` })
        .where(eq(branches.id, second.id));

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
      const branchLineages = await tree.lineages({ kind: "branch", branchId: first.id }, ids);
      expect([...branchLineages.keys()].sort()).toEqual([harbor, ledger].sort());
      expect(branchLineages.get(harbor)).toMatchObject({
        status: "visible",
        folders: [{ id: await folderId("world"), deleted: false }],
      });
      expect(await tree.lineages(LIVE_TREE, [])).toEqual(new Map());

      const live = await tree.identityStatus(LIVE_TREE, ids);
      expect(live.get(harbor)).toMatchObject({
        kind: "hidden",
        branch: { branchId: first.id, originWorkId: ascension.id },
        usedBy: [{ branchId: first.id }, { branchId: second.id }],
        address: { path: "world/harbor", uri: "manuscript://world/harbor" },
      });
      expect(live.get(ledger)).toMatchObject({
        kind: "deleted",
        lastAddress: { path: "old/ledger" },
      });
      expect(live.get(tomb)).toEqual({ kind: "gone", documentId: tomb });
      expect(live.get(orphan)).toEqual({ kind: "gone", documentId: orphan });
      expect(live.get(missing)).toEqual({ kind: "gone", documentId: missing });
      const rivalView = await tree.identityStatus({ kind: "branch", branchId: second.id }, ids);
      expect(rivalView.get(harbor)).toMatchObject({
        kind: "visible",
        hidden: true,
        address: { path: "world/harbor" },
      });
      expect(rivalView.get(tomb)).toEqual({ kind: "gone", documentId: tomb });
      expect(
        (await tree.identityStatus({ kind: "branch", branchId: third.id }, [harbor])).get(harbor),
      ).toMatchObject({ kind: "hidden", branch: { branchId: first.id } });

      // Tree state: every item at its row's location.
      const intro = await scenario.seedHidden(ascension, "intro");
      await scenario.seedLive("intro");
      const coast = await scenario.seedHidden(ascension, "maps/coast");
      await scenario.seedLive("maps");
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
      await scenario.seedLive("saga/three");
      const tale = await scenario.seedLive("tale/four");
      await softDelete(tale, ["tale"]);
      await scenario.seedLiveFolder("tale/four");
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
      });
      expect(state.get(intro)).toMatchObject({
        target: { path: "intro (2)", uri: "manuscript://intro (2)" },
      });
      expect(state.get(coast)).toMatchObject({
        target: { path: "maps (2)/coast", uri: "manuscript://maps (2)/coast" },
      });
      expect(state.get(chapter)).toMatchObject({
        hidden: false,
        deleted: false,
        target: { path: "chapters/chapter-one", uri: "manuscript://chapters/chapter-one" },
      });
      expect(state.get(scene)).toMatchObject({
        origin: "created",
        deleted: true,
      });
      expect(state.get(arc)).toMatchObject({
        origin: "edited",
        deleted: true,
        target: { path: "arc/two" },
      });
      expect(state.get(replaced)).toMatchObject({ deleted: true });
      expect(state.get(tale)).toMatchObject({ deleted: true });
      expect(state.get(quiet)).toMatchObject({ origin: "edited" });
      // A tombstone is no longer the branch's item.
      expect(state.has(tomb)).toBe(false);
      expect(
        await db
          .select({ id: branchTreeChanges.nodeId })
          .from(branchTreeChanges)
          .where(and(eq(branchTreeChanges.branchId, first.id), eq(branchTreeChanges.nodeId, tomb))),
      ).toHaveLength(1);
    });
  });
}
