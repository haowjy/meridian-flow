/**
 * What live folder operations do to hidden nodes, through the real commands (contract §8):
 * a delete or a move out of where branches hold folders splits hidden contents into twins
 * at their paths (F-1, F-3), a move between project sources carries them (F-2), a visible
 * folder arriving at a hidden folder's path absorbs it (F-4), and neither race leaves a
 * draft's create behind (I-4, I-5).
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { documents, folders, users } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  type BranchTreeScenario,
  branchTreeScenario,
  type ScenarioWork,
} from "../../../test-support/branch-tree-scenario.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { race } from "../../../test-support/lock-interleave.js";
import { createTreeReader } from "./tree-view.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("live folder operations keep hidden nodes where their branches expect them (postgres)", () => {});
} else {
  describe("live folder operations keep hidden nodes where their branches expect them (postgres)", () => {
    // Commands publish catalog work after commit, so this suite commits for real.
    const committed = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => committed.close());
    const runtimes = useComposedRuntimes(() => committed);
    beforeEach(async () => {
      await deleteDrizzleRows(committed, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      return branchTreeScenario(committed, { runtime, runtimes });
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

    async function idAt(
      scenario: BranchTreeScenario,
      of: ScenarioWork | "live",
      path: string,
    ): Promise<string | null> {
      const stat = await scenario.view(of).stat(path);
      return stat.ok ? (stat.value.documentId ?? null) : null;
    }

    it("splits a nested hidden document off a deleted folder into twins at its path (F-1)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kept = await scenario.seedLive("world/places/kept");
      const world = await scenario.seedLiveFolder("world");
      const places = await scenario.seedLiveFolder("world/places");
      const harbor = await scenario.model(ascension).create("world/places/harbor", "Harbor.");
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
        .soft(await idAt(scenario, ascension, "world/places/harbor"), "the draft still sees it")
        .toBe(harbor);
      expect.soft(await idAt(scenario, "live", "world/places/harbor"), "live does not").toBeNull();
    });

    it("moves hidden contents with a folder between project sources and repoints their source (F-2)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");
      const outline = await scenario.seedLive("notes/outline");
      const notes = await scenario.seedLiveFolder("notes");
      const idea = await scenario.model(ascension).create("notes/idea", "Idea.");
      const plan = await scenario.model(rival).create("notes/deep/plan", "Plan.");
      const [ideaBefore, planBefore] = [await document(idea), await document(plan)];

      expect
        .soft(await scenario.writer.move("notes", "kb://notes"), "the live move")
        .toMatchObject({ ok: true });

      const kb = scenario.project.sources.kb;
      for (const [work, id, path, before] of [
        [ascension, idea, "notes/idea", ideaBefore],
        [rival, plan, "notes/deep/plan", planBefore],
      ] as const) {
        expect.soft(await document(id), `${path}: moved along, hidden`).toMatchObject({
          hidden: true,
          deleted: false,
          contextSourceId: kb,
          locationVersion: before.locationVersion + 1n,
        });
        expect.soft(await idAt(scenario, work, `kb://${path}`), `${path}: in its draft`).toBe(id);
        expect.soft(await idAt(scenario, work, path), `${path}: not left behind`).toBeNull();
        expect.soft(await idAt(scenario, "live", `kb://${path}`), `${path}: not live`).toBeNull();
      }
      expect.soft(await idAt(scenario, "live", "kb://notes/outline")).toBe(outline);
      expect.soft((await folder(notes)).locationVersion, "the moved folder's version").toBe(1n);
    });

    it("splits a nested hidden document off a folder moved out of user:// or into a Work's Scratch (F-3)", async () => {
      // Out of user:// into a project narrows which branches may hold it (§8.3, D20); a
      // Work's Scratch is held by none.
      for (const into of ["project", "scratch"] as const) {
        const scenario = await start();
        const ascension = await scenario.work(`Ascension ${into}`, "draft");
        const origin = into === "project" ? "user://world" : "world";
        const stays =
          into === "project" ? scenario.project.sources.user : scenario.project.sources.manuscript;
        const destination =
          into === "project"
            ? "world"
            : `scratch://@${(await scenario.work("Notes", "direct")).slug}/world`;
        const map = await scenario.seedLive(`${origin}/places/map`);
        const places = await scenario.seedLiveFolder(`${origin}/places`);
        const harbor = await scenario.model(ascension).create(`${origin}/places/harbor`, "Harbor.");

        expect
          .soft(await scenario.writer.move(origin, destination), `${destination}: the live move`)
          .toMatchObject({ ok: true });

        const now = await document(harbor);
        expect.soft(now, `${destination}: harbor stays where it was, hidden`).toMatchObject({
          hidden: true,
          deleted: false,
          contextSourceId: stays,
        });
        expect.soft(now.folderId, `${destination}: under a twin`).not.toBe(places);
        const twin = await folder(now.folderId);
        expect.soft(twin, `${destination}: places' twin`).toMatchObject({
          name: "places",
          hidden: true,
          contextSourceId: stays,
        });
        expect.soft(await folder(twin.parentId), `${destination}: world's twin`).toMatchObject({
          name: "world",
          hidden: true,
          parentId: null,
        });
        expect
          .soft((await folder(places)).contextSourceId, `${destination}: the live folder left`)
          .not.toBe(stays);
        expect
          .soft(
            await idAt(scenario, ascension, `${origin}/places/harbor`),
            `${destination}: the draft still sees it`,
          )
          .toBe(harbor);
        expect
          .soft(await idAt(scenario, "live", `${destination}/places/map`), destination)
          .toBe(map);
      }

      // The parent stays; the child leaves for a Work's Scratch, so its hidden contents split off
      // under a twin of the child at the original path.
      const scenario = await start();
      const ascension = await scenario.work("Ascension child", "draft");
      await scenario.seedLive("q/t/visible");
      const [q, t] = [await scenario.seedLiveFolder("q"), await scenario.seedLiveFolder("q/t")];
      const stayed = await scenario.model(ascension).create("q/t/hidden", "Hidden.");
      const stayedBefore = await document(stayed);
      expect
        .soft(
          await scenario.writer.move(
            "q/t",
            `scratch://@${(await scenario.work("Notes", "direct")).slug}/t`,
          ),
          "the child's live move",
        )
        .toMatchObject({ ok: true });
      const kept = await document(stayed);
      expect.soft(kept, "split off, unchanged").toMatchObject({
        hidden: true,
        contextSourceId: scenario.project.sources.manuscript,
        locationVersion: stayedBefore.locationVersion,
      });
      expect.soft(kept.folderId, "under a twin").not.toBe(t);
      expect.soft(await folder(kept.folderId), "t's twin, under the staying q").toMatchObject({
        name: "t",
        hidden: true,
        parentId: q,
      });
      expect.soft(await idAt(scenario, ascension, "q/t/hidden")).toBe(stayed);
    });

    it("absorbs a hidden folder beside a same-named visible document: a draft clash, never a live refusal (F-4)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kaelFile = await scenario.seedLive("branches/kael");
      const branches = await scenario.seedLiveFolder("branches");
      const notes = await scenario.model(ascension).create("ideas/kael/notes", "Notes.");
      const branch = await scenario.branchOf(ascension);
      const hiddenKael = (await document(notes)).folderId;
      const hiddenIdeas = (await folder(hiddenKael)).parentId;

      expect
        .soft(await scenario.writer.move("branches", "ideas"), "no live refusal")
        .toMatchObject({ ok: true });

      expect.soft(await folder(hiddenIdeas), "the hidden folder tombstoned").toMatchObject({
        deleted: true,
        locationVersion: 1n,
      });
      expect.soft(await folder(hiddenKael), "its child folded in").toMatchObject({
        hidden: true,
        deleted: false,
        parentId: branches,
        locationVersion: 0n,
      });
      expect.soft(await idAt(scenario, "live", "ideas/kael"), "the live file").toBe(kaelFile);
      const resolved = await createTreeReader(committed).resolvePath(
        { kind: "branch", branchId: branch.id },
        { contextSourceId: scenario.project.sources.manuscript, path: "ideas/kael" },
      );
      expect.soft(resolved.kind, "two nodes at one path in the draft").toBe("ambiguous");
      const [item] = await createTreeReader(committed).treeState(branch.id);
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
            branchId: expect.any(String),
            itemKey: expect.any(String),
            reason: { code: "path_taken", path: "manuscript://ideas/kael" },
          },
        },
      ]);
      expect.soft((await document(notes)).hidden, "still hidden after Apply").toBe(true);
    });

    it("answers a path two of a draft's documents share with the clash, never one of them (absorb)", async () => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      await scenario.seedLiveFolder("branches");
      const first = await scenario.model(ascension).create("branches/note", "First.");
      const second = await scenario.model(ascension).create("ideas/note", "Second.");
      expect
        .soft(await scenario.writer.move("branches", "ideas"), "no live refusal")
        .toMatchObject({
          ok: true,
        });

      const view = scenario.view(ascension);
      const clash = { ok: false, error: { code: "invalid_operation" } };
      expect.soft(await view.stat("ideas/note"), "stat").toMatchObject(clash);
      expect.soft(await view.read("ideas/note"), "read").toMatchObject(clash);
      expect.soft(await view.ls("ideas"), "listing the folder both landed in").toMatchObject({
        ok: true,
      });
      expect.soft((await document(first)).hidden && (await document(second)).hidden).toBe(true);
    });

    it.each([
      { first: "rename" as const, at: "absorb.beforeRepoint" as const },
      { first: "create" as const, at: "createInBranch.afterCandidateLock" as const },
    ])("never leaves a draft's create under an absorbed folder, $first first (I-4)", async ({
      first,
      at,
    }) => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const notes = await scenario.seedLiveFolder("notes");
      const existing = await scenario.model(ascension).create("ideas/first", "First.");
      const hiddenIdeas = (await document(existing)).folderId;
      const { bWaited, by } = await race(
        committed,
        {
          rename: () => scenario.writer.move("notes", "ideas"),
          create: () => scenario.model(ascension).create("ideas/second", "Second."),
        },
        first,
        at,
      );
      expect.soft(bWaited, "the second waits").toBe(true);
      expect.soft(by.rename.ok && by.rename.value, "renamed").toMatchObject({ ok: true });
      if (!by.create.ok) throw by.create.error;
      const second = by.create.value as string;
      expect.soft((await folder(hiddenIdeas)).deleted, "absorbed").toBe(true);
      for (const id of [existing, second]) {
        expect.soft(await document(id), "under the live folder").toMatchObject({
          hidden: true,
          deleted: false,
          folderId: notes,
        });
      }
      expect.soft(await idAt(scenario, ascension, "ideas/second")).toBe(second);
    });

    it.each([
      { first: "remove" as const, at: "split.beforeRepoint" as const },
      { first: "create" as const, at: "createInBranch.afterCandidateLock" as const },
    ])("never leaves a draft's create in a split folder, $first first (I-5)", async ({
      first,
      at,
    }) => {
      const scenario = await start();
      const ascension = await scenario.work("Ascension", "draft");
      await scenario.seedLive("world/places/kept");
      const places = await scenario.seedLiveFolder("world/places");
      const existing = await scenario.model(ascension).create("world/places/first", "First.");
      const { bWaited, by } = await race(
        committed,
        {
          remove: () => scenario.writer.delete("world"),
          create: () => scenario.model(ascension).create("world/places/second", "Second."),
        },
        first,
        at,
      );
      expect.soft(bWaited, "the second waits").toBe(true);
      expect.soft(by.remove.ok && by.remove.value, "deleted").toMatchObject({ ok: true });
      if (!by.create.ok) throw by.create.error;
      const second = by.create.value as string;
      const twin = (await document(existing)).folderId;
      expect.soft(twin, "split off").not.toBe(places);
      for (const id of [existing, second]) {
        expect.soft(await document(id), "hidden in the twin").toMatchObject({
          hidden: true,
          deleted: false,
          folderId: twin,
        });
      }
      expect.soft(await idAt(scenario, ascension, "world/places/second")).toBe(second);
    });
  });
}
