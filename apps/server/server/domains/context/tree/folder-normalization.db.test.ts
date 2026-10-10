/**
 * What live folder operations do to hidden nodes, through the real commands (contract §8):
 * a delete or a move out of where drafts hold folders splits hidden contents into twins
 * at their paths (F-1, F-3), a move between project sources carries them (F-2), a visible
 * folder arriving at a hidden folder's path absorbs it (F-4), and neither race leaves a
 * draft's create behind (I-4, I-5). F-2 and F-3 also drive the batch move primitive the
 * way Apply's relocation will (F-R1, F-R2, F-R3).
 */
import { randomUUID } from "node:crypto";
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  documentPreviousLocations,
  documents,
  draftTreeChanges,
  folders,
  users,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { Ok } from "../../../shared/result.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioWork,
} from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { race } from "../../../test-support/lock-interleave.js";
import { lockContextSources } from "../adapters/context-fs/document-locations.js";
import { moveNodes, type NodeMove } from "./node-moves.js";
import { createTreeReader } from "./tree-view.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("live folder operations keep hidden nodes where their drafts expect them (postgres)", () => {});
} else {
  describe("live folder operations keep hidden nodes where their drafts expect them (postgres)", () => {
    // Commands publish catalog work after commit, so this suite commits for real.
    const committed = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => committed.close());
    const runtimes = useComposedRuntimes(() => committed);
    beforeEach(async () => {
      await deleteDrizzleRows(committed, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      return draftTreeScenario(committed, { runtime, runtimes });
    }

    async function document(id: string) {
      const [row] = await committed
        .select({
          hidden: documents.hidden,
          deleted: sql<boolean>`${documents.deletedAt} IS NOT NULL`,
          contextSourceId: documents.contextSourceId,
          folderId: documents.folderId,
          locationVersion: documents.locationVersion,
        })
        .from(documents)
        .where(eq(documents.id, id));
      if (!row) throw new Error(`no document ${id}`);
      return row;
    }

    async function folder(id: string | null) {
      const [row] = await committed
        .select({
          name: folders.name,
          hidden: folders.hidden,
          deleted: sql<boolean>`${folders.deletedAt} IS NOT NULL`,
          contextSourceId: folders.contextSourceId,
          parentId: folders.parentId,
          locationVersion: folders.locationVersion,
        })
        .from(folders)
        .where(eq(folders.id, id ?? randomUUID()));
      if (!row) throw new Error(`no folder ${id}`);
      return row;
    }

    async function changeRow(draftId: string, documentId: string) {
      const [row] = await committed
        .select({
          contextSourceId: draftTreeChanges.contextSourceId,
          parentFolderId: draftTreeChanges.parentFolderId,
        })
        .from(draftTreeChanges)
        .where(and(eq(draftTreeChanges.draftId, draftId), eq(draftTreeChanges.nodeId, documentId)));
      return row ?? null;
    }

    async function idAt(
      scenario: DraftTreeScenario,
      of: ScenarioWork | "live",
      path: string,
    ): Promise<string | null> {
      const stat = await scenario.view(of).stat(path);
      return stat.ok ? (stat.value.documentId ?? null) : null;
    }

    /** Apply's relocation shape: several nodes through the batch primitive, rolled back on refusal. */
    async function batchMove(
      sourceIds: readonly string[],
      moves: readonly NodeMove[],
    ): Promise<{ ok: true } | { ok: false; code: string }> {
      class Refused extends Error {
        constructor(readonly code: string) {
          super(code);
        }
      }
      try {
        await runInDrizzleTransaction(committed, async () => {
          await lockContextSources(committed, sourceIds);
          const moved = await moveNodes(committed, { moves, filetypeFor: () => Ok(null) });
          if (!moved.ok) throw new Refused(moved.error.code);
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof Refused) return { ok: false, code: error.code };
        const cause = (error as { cause?: { code?: string } }).cause;
        return { ok: false, code: cause?.code ?? String(error) };
      }
    }

    const toFolder = (
      id: string,
      sourceId: string,
      name: string,
      dir: string[] = [],
    ): NodeMove => ({
      node: { kind: "folder", id: id as FolderId },
      to: { contextSourceId: sourceId as ContextSourceId, dir, name },
    });
    const toDocument = (
      id: string,
      sourceId: string,
      name: string,
      dir: string[] = [],
    ): NodeMove => ({
      node: { kind: "document", id: id as DocumentId },
      to: { contextSourceId: sourceId as ContextSourceId, dir, name, extension: "md" },
    });

    /** No temporary vacate name survives anywhere in these sources. */
    async function parkedNames(sourceIds: readonly string[]) {
      return committed
        .select({ name: folders.name })
        .from(folders)
        .where(
          and(
            inArray(folders.contextSourceId, sourceIds as ContextSourceId[]),
            sql`position(chr(1) in ${folders.name}) > 0`,
          ),
        );
    }

    it("splits a nested hidden document off a deleted folder into twins at its path (F-1)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kept = await scenario.seedLive("world/places/kept.md");
      const world = await scenario.seedLiveFolder("world");
      const places = await scenario.seedLiveFolder("world/places");
      const harbor = await scenario.model(ascension).create("world/places/harbor.md", "Harbor.");
      const draft = await scenario.draftOf(ascension);
      const before = await document(harbor);

      const deleted = await scenario.writer.delete("world");
      expect.soft(deleted, "the live delete").toMatchObject({ ok: true });
      if (deleted.ok) {
        expect
          .soft(deleted.value.deletedDocumentIds, "receipt names live rows only")
          .toEqual([kept]);
      }

      const now = await document(harbor);
      expect.soft(now, "harbor stays hidden and live").toMatchObject({
        hidden: true,
        deleted: false,
        contextSourceId: scenario.project.sources.manuscript,
        locationVersion: before.locationVersion,
      });
      const placesTwin = await folder(now.folderId);
      const worldTwin = await folder(placesTwin.parentId);
      expect.soft(now.folderId, "under a new folder").not.toBe(places);
      expect.soft(placesTwin, "places' twin").toMatchObject({
        name: "places",
        hidden: true,
        deleted: false,
        locationVersion: 0n,
      });
      expect.soft(placesTwin.parentId, "under world's twin").not.toBe(world);
      expect.soft(worldTwin, "world's twin, with no hidden child of its own").toMatchObject({
        name: "world",
        hidden: true,
        deleted: false,
        parentId: null,
        locationVersion: 0n,
      });
      expect.soft(await changeRow(draft.id, harbor), "change row repointed").toEqual({
        contextSourceId: scenario.project.sources.manuscript,
        parentFolderId: now.folderId,
      });
      expect
        .soft(
          [await folder(world), await folder(places), await document(kept)],
          "deleted rows each take a version",
        )
        .toEqual([
          expect.objectContaining({ deleted: true, locationVersion: 1n }),
          expect.objectContaining({ deleted: true, locationVersion: 1n }),
          expect.objectContaining({ deleted: true, locationVersion: 1n }),
        ]);
      expect
        .soft(await idAt(scenario, ascension, "world/places/harbor.md"), "the draft still sees it")
        .toBe(harbor);
      expect
        .soft(await idAt(scenario, "live", "world/places/harbor.md"), "live does not")
        .toBeNull();
    });

    it("moves hidden contents with a folder between project sources and repoints their source (F-2)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");
      const outline = await scenario.seedLive("notes/outline.md");
      const notes = await scenario.seedLiveFolder("notes");
      const idea = await scenario.model(ascension).create("notes/idea.md", "Idea.");
      const plan = await scenario.model(rival).create("notes/deep/plan.md", "Plan.");
      const [ideaBefore, planBefore] = [await document(idea), await document(plan)];

      expect
        .soft(await scenario.writer.move("notes", "kb://notes"), "the live move")
        .toMatchObject({ ok: true });

      const kb = scenario.project.sources.kb;
      for (const [work, id, path, before] of [
        [ascension, idea, "notes/idea.md", ideaBefore],
        [rival, plan, "notes/deep/plan.md", planBefore],
      ] as const) {
        const draft = await scenario.draftOf(work);
        expect.soft(await document(id), `${path}: moved along, hidden`).toMatchObject({
          hidden: true,
          deleted: false,
          contextSourceId: kb,
          locationVersion: before.locationVersion + 1n,
        });
        expect
          .soft((await changeRow(draft.id, id))?.contextSourceId, `${path}: row takes the source`)
          .toBe(kb);
        expect.soft(await idAt(scenario, work, `kb://${path}`), `${path}: in its draft`).toBe(id);
        expect.soft(await idAt(scenario, work, path), `${path}: not left behind`).toBeNull();
        expect.soft(await idAt(scenario, "live", `kb://${path}`), `${path}: not live`).toBeNull();
      }
      expect.soft(await idAt(scenario, "live", "kb://notes/outline.md")).toBe(outline);
      expect.soft((await folder(notes)).locationVersion, "the moved folder's version").toBe(1n);

      // The batch primitive's final namespace includes what moving folders carry (F-R1).
      const m = scenario.project.sources.manuscript;
      const a = await scenario.seedLiveFolder("a");
      await scenario.seedLive("a/x.md");
      const c = await scenario.seedLive("c.md");
      expect
        .soft(await batchMove([m], [toFolder(a, m, "b"), toDocument(c, m, "x", ["b"])]))
        .toEqual({ ok: false, code: "conflict" });
      const e = await scenario.seedLiveFolder("e");
      await scenario.seedLiveFolder("e/x.md");
      const f = await scenario.seedLive("f.md");
      expect
        .soft(await batchMove([m], [toFolder(e, m, "g"), toDocument(f, m, "x", ["g"])]))
        .toEqual({ ok: false, code: "conflict" });
      expect.soft(await idAt(scenario, "live", "f.md"), "a refused batch moves nothing").toBe(f);
      // A selected child vacating the slot its folder carries frees it.
      const h = await scenario.seedLiveFolder("h");
      const hx = await scenario.seedLive("h/x.md");
      const k = await scenario.seedLive("k.md");
      expect
        .soft(
          await batchMove(
            [m],
            [toFolder(h, m, "i"), toDocument(hx, m, "z"), toDocument(k, m, "x", ["i"])],
          ),
        )
        .toEqual({ ok: true });
      expect.soft(await idAt(scenario, "live", "i/x.md"), "freed slot").toBe(k);
      expect.soft(await idAt(scenario, "live", "z.md"), "selected child").toBe(hx);
      // A swap leaves no alias at a path the final tree occupies (F-R3).
      const sDoc = await scenario.seedLive("s.md");
      const tDoc = await scenario.seedLive("t.md");
      expect
        .soft(await batchMove([m], [toDocument(sDoc, m, "t"), toDocument(tDoc, m, "s")]))
        .toEqual({ ok: true });
      expect
        .soft(
          await committed
            .select({ path: documentPreviousLocations.path })
            .from(documentPreviousLocations)
            .where(
              and(
                eq(documentPreviousLocations.contextSourceId, m),
                inArray(documentPreviousLocations.path, ["s.md", "t.md"]),
              ),
            ),
          "swap history",
        )
        .toEqual([]);
      expect
        .soft([(await document(sDoc)).locationVersion, (await document(tDoc)).locationVersion])
        .toEqual([1n, 1n]);
    });

    it("splits a nested hidden document off a folder moved out of the project or into a Work's Scratch (F-3)", async () => {
      // Personal ↔ project (§8.3), and a Work's Scratch, which no draft ever holds.
      for (const into of ["user", "scratch"] as const) {
        const scenario = await start();
        const ascension = await scenario.work(`Ascension ${into}`, "draft");
        const destination =
          into === "user"
            ? "user://world"
            : `scratch://@${(await scenario.work("Notes", "direct")).slug}/world`;
        const map = await scenario.seedLive("world/places/map.md");
        const places = await scenario.seedLiveFolder("world/places");
        const harbor = await scenario.model(ascension).create("world/places/harbor.md", "Harbor.");
        const draft = await scenario.draftOf(ascension);

        expect
          .soft(await scenario.writer.move("world", destination), `${destination}: the live move`)
          .toMatchObject({ ok: true });

        const now = await document(harbor);
        expect.soft(now, `${destination}: harbor stays in Manuscript, hidden`).toMatchObject({
          hidden: true,
          deleted: false,
          contextSourceId: scenario.project.sources.manuscript,
        });
        expect.soft(now.folderId, `${destination}: under a twin`).not.toBe(places);
        const twin = await folder(now.folderId);
        expect.soft(twin, `${destination}: places' twin`).toMatchObject({
          name: "places",
          hidden: true,
          contextSourceId: scenario.project.sources.manuscript,
        });
        expect.soft(await folder(twin.parentId), `${destination}: world's twin`).toMatchObject({
          name: "world",
          hidden: true,
          parentId: null,
        });
        expect
          .soft((await folder(places)).contextSourceId, `${destination}: the live folder left`)
          .not.toBe(scenario.project.sources.manuscript);
        expect.soft(await changeRow(draft.id, harbor), `${destination}: row repointed`).toEqual({
          contextSourceId: scenario.project.sources.manuscript,
          parentFolderId: now.folderId,
        });
        expect
          .soft(
            await idAt(scenario, ascension, "world/places/harbor.md"),
            `${destination}: the draft still sees it`,
          )
          .toBe(harbor);
        expect
          .soft(await idAt(scenario, "live", `${destination}/places/map.md`), destination)
          .toBe(map);
      }

      // Overlapping selected folders in one batch (F-R2): a selected child owns its subtree,
      // and a split twins at original coordinates even when an ancestor moves too.
      const scenario = await start();
      const elsewhere = (await start()).project.sources.manuscript;
      const { manuscript: m, kb } = scenario.project.sources;
      const sources = [m, kb, elsewhere];
      const ascension = await scenario.work("Ascension overlap", "draft");
      const draft = await scenario.draftOf(ascension);
      // The parent leaves the project; the child stays in it, so its hidden contents follow it.
      await scenario.seedLive("p/r/visible.md");
      const [p, r] = [await scenario.seedLiveFolder("p"), await scenario.seedLiveFolder("p/r")];
      const followed = await scenario.model(ascension).create("p/r/hidden.md", "Hidden.");
      const followedBefore = await document(followed);
      expect
        .soft(await batchMove(sources, [toFolder(p, elsewhere, "p"), toFolder(r, kb, "r")]))
        .toEqual({ ok: true });
      expect.soft(await document(followed), "moved with its own folder").toMatchObject({
        hidden: true,
        contextSourceId: kb,
        folderId: r,
        locationVersion: followedBefore.locationVersion + 1n,
      });
      expect.soft(await changeRow(draft.id, followed), "its row follows").toEqual({
        contextSourceId: kb,
        parentFolderId: r,
      });
      expect.soft(await idAt(scenario, ascension, "kb://r/hidden.md")).toBe(followed);
      // The parent stays in the project; the child leaves, so its hidden contents split off
      // under twins at the original path, the moved parent included.
      await scenario.seedLive("q/t/visible.md");
      const [q, t] = [await scenario.seedLiveFolder("q"), await scenario.seedLiveFolder("q/t")];
      const stayed = await scenario.model(ascension).create("q/t/hidden.md", "Hidden.");
      const stayedBefore = await document(stayed);
      expect
        .soft(await batchMove(sources, [toFolder(q, kb, "q"), toFolder(t, elsewhere, "t")]))
        .toEqual({ ok: true });
      const kept = await document(stayed);
      expect.soft(kept, "split off, unchanged").toMatchObject({
        hidden: true,
        contextSourceId: m,
        locationVersion: stayedBefore.locationVersion,
      });
      const tTwin = await folder(kept.folderId);
      expect.soft(kept.folderId, "under a twin").not.toBe(t);
      expect.soft(tTwin, "t's twin").toMatchObject({ name: "t", hidden: true, contextSourceId: m });
      expect.soft(await folder(tTwin.parentId), "q's twin, at q's old path").toMatchObject({
        name: "q",
        hidden: true,
        contextSourceId: m,
        parentId: null,
      });
      expect.soft(tTwin.parentId, "not the moved q").not.toBe(q);
      expect.soft((await changeRow(draft.id, stayed))?.parentFolderId).toBe(kept.folderId);
      expect.soft(await idAt(scenario, ascension, "q/t/hidden.md")).toBe(stayed);
      expect.soft(await parkedNames(sources), "no parked name persists").toEqual([]);
    });

    it("absorbs a hidden folder beside a same-named visible document: a draft clash, never a live refusal (F-4)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kaelFile = await scenario.seedLive("drafts/kael");
      const drafts = await scenario.seedLiveFolder("drafts");
      const notes = await scenario.model(ascension).create("ideas/kael/notes.md", "Notes.");
      const draft = await scenario.draftOf(ascension);
      const hiddenKael = (await document(notes)).folderId;
      const hiddenIdeas = (await folder(hiddenKael)).parentId;

      expect
        .soft(await scenario.writer.move("drafts", "ideas"), "no live refusal")
        .toMatchObject({ ok: true });

      expect.soft(await folder(hiddenIdeas), "the hidden folder tombstoned").toMatchObject({
        deleted: true,
        locationVersion: 1n,
      });
      expect.soft(await folder(hiddenKael), "its child folded in").toMatchObject({
        hidden: true,
        deleted: false,
        parentId: drafts,
        locationVersion: 0n,
      });
      expect.soft(await idAt(scenario, "live", "ideas/kael"), "the live file").toBe(kaelFile);
      const resolved = await createTreeReader(committed).resolvePath(
        { kind: "draft", draftId: draft.id },
        { contextSourceId: scenario.project.sources.manuscript, path: "ideas/kael" },
      );
      expect.soft(resolved.kind, "two nodes at one path in the draft").toBe("ambiguous");
      const [item] = await createTreeReader(committed).treeState(draft.id);
      expect.soft(item?.conflict, "a clash in the draft's view").toEqual({
        kind: "clash",
        withNode: { kind: "document", id: kaelFile },
        at: "ideas/kael",
        uri: "manuscript://ideas/kael",
      });
      expect.soft(await scenario.apply(ascension, [notes]), "held at Apply (F11)").toEqual([
        {
          httpStatus: 409,
          body: {
            status: "held",
            draftId: expect.any(String),
            reason: { code: "path_taken", path: "manuscript://ideas/kael" },
          },
        },
      ]);
      expect.soft((await document(notes)).hidden, "still hidden after Apply").toBe(true);
    });

    it.each([
      { first: "rename" as const, at: "absorb.beforeRepoint" as const },
      { first: "create" as const, at: "createInDraft.afterCandidateLock" as const },
    ])("never leaves a draft's create under an absorbed folder, $first first (I-4)", async ({
      first,
      at,
    }) => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const notes = await scenario.seedLiveFolder("notes");
      const existing = await scenario.model(ascension).create("ideas/first.md", "First.");
      const hiddenIdeas = (await document(existing)).folderId;
      const { bWaited, by } = await race(
        committed,
        {
          rename: () => scenario.writer.move("notes", "ideas"),
          create: () => scenario.model(ascension).create("ideas/second.md", "Second."),
        },
        first,
        at,
      );
      expect.soft(bWaited, "the second waits").toBe(true);
      expect.soft(by.rename.ok && by.rename.value, "renamed").toMatchObject({ ok: true });
      if (!by.create.ok) throw by.create.error;
      const second = by.create.value as string;
      const draft = await scenario.draftOf(ascension);
      expect.soft((await folder(hiddenIdeas)).deleted, "absorbed").toBe(true);
      for (const id of [existing, second]) {
        expect.soft(await document(id), "under the live folder").toMatchObject({
          hidden: true,
          deleted: false,
          folderId: notes,
        });
        expect.soft((await changeRow(draft.id, id))?.parentFolderId, "its row too").toBe(notes);
      }
      expect.soft(await idAt(scenario, ascension, "ideas/second.md")).toBe(second);
    });

    it.each([
      { first: "remove" as const, at: "split.beforeRepoint" as const },
      { first: "create" as const, at: "createInDraft.afterCandidateLock" as const },
    ])("never leaves a draft's create in a split folder, $first first (I-5)", async ({
      first,
      at,
    }) => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      await scenario.seedLive("world/places/kept.md");
      const places = await scenario.seedLiveFolder("world/places");
      const existing = await scenario.model(ascension).create("world/places/first.md", "First.");
      const { bWaited, by } = await race(
        committed,
        {
          remove: () => scenario.writer.delete("world"),
          create: () => scenario.model(ascension).create("world/places/second.md", "Second."),
        },
        first,
        at,
      );
      expect.soft(bWaited, "the second waits").toBe(true);
      expect.soft(by.remove.ok && by.remove.value, "deleted").toMatchObject({ ok: true });
      if (!by.create.ok) throw by.create.error;
      const second = by.create.value as string;
      const draft = await scenario.draftOf(ascension);
      const twin = (await document(existing)).folderId;
      expect.soft(twin, "split off").not.toBe(places);
      for (const id of [existing, second]) {
        expect.soft(await document(id), "hidden in the twin").toMatchObject({
          hidden: true,
          deleted: false,
          folderId: twin,
        });
        expect.soft((await changeRow(draft.id, id))?.parentFolderId, "its row too").toBe(twin);
      }
      expect.soft(await idAt(scenario, ascension, "world/places/second.md")).toBe(second);
    });
  });
}
