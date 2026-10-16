/** Consolidated test contracts; each block retains its original fixture scope. */

import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  documents,
  documentYjsUpdates,
  draftTreeChanges,
  folders,
  users,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  itemFor,
  type ScenarioWork,
} from "../../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../../test-support/draft-tree-suite.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { race } from "../../../test-support/lock-interleave.js";
import { setCollabHook } from "../../collab/domain/collab-test-hooks.js";
import { createDrizzleContextCatalog } from "../adapters/context-catalog.js";
import { setLiveCreateHook } from "../adapters/context-fs/live-create.js";
import { endUse } from "./end-use.js";
import { createTreeReader, LIVE_TREE, type TreeView } from "./tree-view.js";

__mergedSuite("hidden-nodes.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/tree/hidden-nodes.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("hidden-node lifecycle (postgres)", () => {});
  } else {
    __mergedSuite("hidden-node lifecycle (postgres)", () => {
      // Creates publish catalog repairs after commit, so this suite commits for real.
      const db = createDb(DATABASE_URL, { max: 12 });
      afterAll(() => db.close());
      const runtimes = useComposedRuntimes(() => db);
      const tree = createTreeReader(db);
      beforeEach(async () => {
        await deleteDrizzleRows(db, [users]);
      });
      async function start() {
        const runtime = await runtimes.compose();
        const scenario = await draftTreeScenario(db, { runtime, runtimes });
        return { runtime, scenario };
      }
      /** The document's identity as the live view reads it. */
      async function liveStatus(id: string) {
        return (await tree.identityStatus(LIVE_TREE, [id as DocumentId])).get(id as DocumentId);
      }
      /** What `view` shows at a Manuscript path. */
      function at(scenario: DraftTreeScenario, view: TreeView, path: string) {
        return tree.resolvePath(view, {
          contextSourceId: scenario.project.sources.manuscript,
          path,
        });
      }
      /** The folder id `view` shows at a Manuscript path, else null. */
      async function folderAt(scenario: DraftTreeScenario, view: TreeView, path: string) {
        const found = await at(scenario, view, path);
        return found.kind === "found" && found.node.kind === "folder" ? found.node.folder.id : null;
      }
      async function draftView(scenario: DraftTreeScenario, work: ScenarioWork): Promise<TreeView> {
        return { kind: "draft", draftId: (await scenario.draftOf(work)).id };
      }
      /** The documents the Work's draft created, as its tree state lists them. */
      async function createdIn(scenario: DraftTreeScenario, work: ScenarioWork) {
        const draft = await scenario.draftOf(work);
        return (await tree.treeState(draft.id))
          .filter((node) => node.origin === "created")
          .map((node) => node.nodeId);
      }
      /** Whether the row is a tombstone; null when no row has the id. */
      async function tombstoned(id: string) {
        const [row] = await db
          .select({ deletedAt: documents.deletedAt })
          .from(documents)
          .where(eq(documents.id, id as DocumentId));
        return row ? row.deletedAt !== null : null;
      }
      /** Every draft whose change row names the document, whatever the document's state. */
      async function rowsNaming(id: string) {
        return (
          await db
            .select({ draftId: draftTreeChanges.draftId })
            .from(draftTreeChanges)
            .where(eq(draftTreeChanges.nodeId, id))
        ).map((row) => row.draftId);
      }
      /** Folders of the scenario named `name` that aren't tombstones, hidden ones included. */
      async function foldersNamed(scenario: DraftTreeScenario, name: string) {
        return db
          .select({ id: folders.id })
          .from(folders)
          .where(
            and(
              eq(folders.name, name),
              isNull(folders.deletedAt),
              inArray(folders.contextSourceId, Object.values(scenario.project.sources)),
            ),
          );
      }
      it("makes a draft's create an empty hidden row its drafts share (C-2)", async () => {
        const { runtime, scenario } = await start();
        const ascension = await scenario.work("Ascension", "draft");
        const rival = await scenario.work("Rival", "draft");
        const kael = await scenario.model(ascension).create("lore/kael", "Kael, drafted.");
        const draft = await scenario.draftOf(ascension);
        expect
          .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live Yjs is never seeded")
          .toEqual({ ok: true, value: "" });
        expect
          .soft(await liveStatus(kael), "hidden, used by the draft")
          .toMatchObject({ kind: "hidden", usedBy: [{ draftId: draft.id }] });
        expect
          .soft(await folderAt(scenario, LIVE_TREE, "lore"), "its folder is in no live view")
          .toBeNull();
        expect
          .soft(
            await at(scenario, await draftView(scenario, ascension), "lore"),
            "the draft's hidden folder",
          )
          .toMatchObject({ kind: "found", node: { kind: "folder", folder: { hidden: true } } });
        expect.soft(await createdIn(scenario, ascension), "the draft's create").toEqual([kael]);
        expect
          .soft(await scenario.draftBranch(ascension, kael), "the draft's branch")
          .toMatchObject({ branchId: expect.any(String) });
        const pending = await runtime.ports.documentSync.draftReview.list({
          projectId: scenario.project.id,
          workId: ascension.id,
        });
        expect
          .soft(
            pending.map((item) => item.documentId),
            "pending in its Work",
          )
          .toContain(kael);
        // The same draft creating it again uses the document it already has.
        const again = await scenario.model(ascension).reply();
        const rewritten = await again.call("write", {
          command: "create",
          path: "manuscript://lore/kael",
          content: "Kael, again.",
          overwrite: true,
        });
        await again.save();
        expect.soft(rewritten.isError ?? false, "the overwrite succeeds").toBe(false);
        expect.soft(await createdIn(scenario, ascension), "one create per draft").toEqual([kael]);
        // Another draft's create at the path joins the same hidden document.
        const joined = await scenario.model(rival).create("lore/kael", "Kael, the rival's.");
        expect.soft(joined, "a second draft joins").toBe(kael);
        expect.soft(await createdIn(scenario, rival), "the rival's create").toEqual([kael]);
        expect
          .soft(await scenario.view("live").stat("lore/kael"), "still not live")
          .toMatchObject({ ok: false, error: { code: "not_found" } });
        expect
          .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live stays empty")
          .toEqual({ ok: true, value: "" });
      });
      it("reveals the hidden folder at the path on mkdir (C-3)", async () => {
        const { scenario } = await start();
        const ascension = await scenario.work("Ascension", "draft");
        await scenario.model(ascension).create("notes/first", "Notes, drafted.");
        const notes = await folderAt(scenario, await draftView(scenario, ascension), "notes");
        await scenario.writer.mkdir("notes");
        expect(notes, "the draft had the folder").not.toBeNull();
        expect(await folderAt(scenario, LIVE_TREE, "notes"), "that folder, live").toBe(notes);
      });
      it("leaves durable and warm live state alone when a held write fails before commit (C-3)", async () => {
        const { runtime, scenario } = await start();
        const ascension = await scenario.work("Ascension", "draft");
        const tide = await scenario.model(ascension).create("tide", "Tide, drafted.");
        // A writer has the document open, so its live room stays warm through the create.
        const warm = await runtime.hocuspocus.openDirectConnection(tide, {
          origin: { type: "system", reason: "warm-room" },
        });
        const warmDoc = warm.document;
        if (!warmDoc) throw new Error("the warm room has no document");
        const warmBefore = Y.encodeStateVector(warmDoc);
        const remove = setLiveCreateHook("liveCreate.afterHeldAdmission", async () => {
          throw new Error("injected after the held admission");
        });
        try {
          await expect(
            scenario.writer.create("tide", { content: "The writer's tide." }),
          ).rejects.toThrow();
        } finally {
          remove();
        }
        expect.soft(await liveStatus(tide), "still hidden").toMatchObject({ kind: "hidden" });
        expect
          .soft(
            await db
              .select({ id: documentYjsUpdates.id })
              .from(documentYjsUpdates)
              .where(eq(documentYjsUpdates.documentId, tide)),
            "nothing journaled",
          )
          .toEqual([]);
        expect.soft(Y.encodeStateVector(warmDoc), "the warm room untouched").toEqual(warmBefore);
        await warm.disconnect();
        expect
          .soft(await runtime.ports.documentSync.readAsMarkdown(tide), "live empty")
          .toEqual({ ok: true, value: "" });
      });
      it("drains a room's background checkpoint before the next fixture reset", async () => {
        const { runtime, scenario } = await start();
        const drafting = await scenario.work("Drafting", "draft");
        const id = await scenario.model(drafting).create("checkpoint", "Drafted.");
        const warm = await runtime.hocuspocus.openDirectConnection(id, {
          origin: { type: "system", reason: "checkpoint-reset" },
        });
        let reached!: (pid: number) => void;
        const atCheckpoint = new Promise<number>((resolve) => {
          reached = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const remove = setCollabHook("checkpoint.afterAuthorityRead", async () => {
          const [row] = await currentDrizzleDb(db).execute<{
            pid: number;
          }>(sql`SELECT pg_backend_pid() AS pid`);
          reached(Number(row.pid));
          await gate;
        });
        let reset: Promise<void> | undefined;
        try {
          if (!warm.document) throw new Error("the warm room has no document");
          await runtime.ports.documentSync.storeHocuspocusDocument(id, warm.document);
          const checkpointPid = await atCheckpoint;
          reset = deleteDrizzleRows(db, [users]);
          // Observe the real lock boundary, not a sleep intended to drain work.
          const deadline = Date.now() + 500;
          let lockWait = false;
          while (Date.now() < deadline) {
            const rows = await db.execute<{
              pid: number;
            }>(sql`
            SELECT pid FROM pg_stat_activity WHERE datname=current_database()
            AND ${checkpointPid}::int = ANY(pg_blocking_pids(pid))`);
            if (rows.length > 0) {
              lockWait = true;
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          release();
          await reset;
          expect(lockWait, "reset never locks tables ahead of an in-flight checkpoint").toBe(false);
        } finally {
          remove();
          release();
          await reset?.catch(() => undefined);
          await runtime.ports.documentSync.drainHocuspocusPersistence();
          await warm.disconnect();
        }
      });
      // §12.2 step 5: a batch's last uses prune every hidden ancestor left empty, whichever
      // document of the batch comes first. An unused hidden folder is in no view, so only its
      // row tells a tombstone from a leftover.
      it("tombstones a shared hidden ancestor when one batch ends sibling subtrees", async () => {
        const order = "one first";
        const { scenario } = await start();
        const drafting = await scenario.work("Drafting", "draft");
        const one = await scenario.seedHidden(drafting, "root/one/x");
        const two = await scenario.seedHidden(drafting, "root/two/y");
        const draft = await scenario.draftOf(drafting);
        const ids = order === "one first" ? [one, two] : [two, one];
        await runInDrizzleTransaction(db, () =>
          endUse(db, { draftId: draft.id, documentIds: ids }),
        );
        expect(await foldersNamed(scenario, "root"), "root pruned").toEqual([]);
        expect(await foldersNamed(scenario, "one")).toEqual([]);
        expect(await foldersNamed(scenario, "two")).toEqual([]);
      });
      // Each fence in both orders: the first run pauses at the hook holding its locks, the
      // second waits on them, then the first finishes.
      it.each([
        { first: "join" as const, at: "createInDraft.afterCandidateLock" as const, joinsX: true },
        { first: "discard" as const, at: "endUse.afterRevalidate" as const, joinsX: false },
      ])("never joins a tombstone nor orphans a node when a join meets a last use, $first first (I-1)", async ({
        first,
        at: point,
        joinsX,
      }) => {
        const { scenario } = await start();
        const firstWork = await scenario.work("First", "draft");
        const second = await scenario.work("Second", "draft");
        const x = await scenario.model(firstWork).create("lore/x", "First's x.");
        const { bWaited, by } = await race(
          db,
          {
            join: () => scenario.model(second).create("lore/x", "Second's x."),
            discard: () => scenario.discard(firstWork, [x]),
          },
          first,
          point,
        );
        expect.soft(bWaited, "the second waits at the fence").toBe(true);
        expect.soft(by.discard.ok, "discard settles").toBe(true);
        if (!by.join.ok) throw by.join.error;
        const seconds = by.join.value as DocumentId;
        const secondDraft = await scenario.draftOf(second);
        expect.soft(seconds === x, "the join takes x only while x is used").toBe(joinsX);
        expect
          .soft(await liveStatus(seconds), "the second's document, hidden for its one user")
          .toMatchObject({ kind: "hidden", usedBy: [{ draftId: secondDraft.id }] });
        expect.soft(await tombstoned(x), "x tombstoned only when nothing joined it").toBe(!joinsX);
        expect
          .soft(await rowsNaming(x), "no row names x but its user's")
          .toEqual(joinsX ? [secondDraft.id] : []);
      });
      it.each([
        { first: "reveal" as const, at: "createLive.afterCandidateLock" as const, revealsY: true },
        { first: "discard" as const, at: "endUse.afterRevalidate" as const, revealsY: false },
      ])("either reveals or tombstones-and-inserts when a reveal meets a last use, $first first (I-2)", async ({
        first,
        at: point,
        revealsY,
      }) => {
        const { scenario } = await start();
        const drafting = await scenario.work("Drafting", "draft");
        const y = await scenario.model(drafting).create("lore/y", "Drafted y.");
        const { bWaited, by } = await race(
          db,
          {
            reveal: () => scenario.writer.create("lore/y"),
            discard: () => scenario.discard(drafting, [y]),
          },
          first,
          point,
        );
        expect.soft(bWaited, "the second waits at the fence").toBe(true);
        expect.soft(by.discard.ok, "discard settles").toBe(true);
        if (!by.reveal.ok) throw by.reveal.error;
        const created = by.reveal.value as {
          status: string;
          documentId?: string;
        };
        expect.soft(created.status, "created").toBe("created");
        expect
          .soft(await at(scenario, LIVE_TREE, "lore/y"), "one live y, the created one")
          .toMatchObject({ kind: "found", node: { document: { id: created.documentId } } });
        expect.soft(created.documentId === y, "y revealed only while used").toBe(revealsY);
        expect.soft(await tombstoned(y), "y tombstoned only when not revealed").toBe(!revealsY);
      });
      it.each([
        "item",
        "whole-draft",
      ] as const)("preserves a revealed draft-created document after %s Discard", async (scope) => {
        const { runtime, scenario } = await start();
        const drafting = await scenario.work("Drafting", "draft");
        const path = "lore/y";
        const y = await scenario.model(drafting).create(path, "Drafted y.");
        const draft = await scenario.draftOf(drafting);
        expect(await liveStatus(y)).toMatchObject({
          kind: "hidden",
          usedBy: [{ draftId: draft.id }],
        });
        expect(await scenario.view(drafting).text(path)).toBe("Drafted y.\n");
        expect(await runtime.ports.documentSync.readAsMarkdown(y)).toEqual({
          ok: true,
          value: "",
        });
        expect(await scenario.writer.create(path)).toEqual({
          status: "created",
          documentId: y,
        });
        expect(await liveStatus(y), "revealed before Discard").toMatchObject({
          kind: "visible",
        });
        const liveText = "The writer's live y.";
        await scenario.writer.write(path, liveText);
        const storageBefore = await db
          .select({ id: documentYjsUpdates.id })
          .from(documentYjsUpdates)
          .where(eq(documentYjsUpdates.documentId, y))
          .orderBy(documentYjsUpdates.id);
        expect(storageBefore, "the writer's live write is durable").not.toEqual([]);
        await scenario.discard(drafting, scope === "item" ? [y] : "all");
        expect.soft(await liveStatus(y), "still visible").toMatchObject({ kind: "visible" });
        expect.soft(await tombstoned(y), "not deleted").toBe(false);
        expect.soft(await scenario.view("live").idAt(path), "same document id").toBe(y);
        expect
          .soft(await scenario.view("live").text(path), "live text intact")
          .toBe(`${liveText}\n`);
        expect.soft(await rowsNaming(y), "no draft tree row remains").toEqual([]);
        expect
          .soft(
            (await scenario.items(drafting)).map((item) => item.documentId),
            "no longer listed for review",
          )
          .not.toContain(y);
        expect
          .soft(
            await db
              .select({ id: documentYjsUpdates.id })
              .from(documentYjsUpdates)
              .where(eq(documentYjsUpdates.documentId, y))
              .orderBy(documentYjsUpdates.id),
            "live storage was not released",
          )
          .toEqual(storageBefore);
      });
      it.each([
        { first: "draft" as const, at: "createInDraft.afterCandidateLock" as const },
        { first: "live" as const, at: "createLive.afterCandidateLock" as const },
      ])("leaves one document when a live create meets a draft create at one path, $first first (I-3)", async ({
        first,
        at: point,
      }) => {
        const { scenario } = await start();
        const drafting = await scenario.work("Drafting", "draft");
        const { bWaited, by } = await race(
          db,
          {
            draft: () => scenario.model(drafting).create("lore/z", "Drafted z."),
            live: () => scenario.writer.create("lore/z"),
          },
          first,
          point,
        );
        expect.soft(bWaited, "the second waits at the fence").toBe(true);
        expect.soft(by.live.ok, "the live create settles").toBe(true);
        if (!by.draft.ok) throw by.draft.error;
        expect
          .soft(await at(scenario, LIVE_TREE, "lore/z"), "one document, live, the draft's")
          .toMatchObject({ kind: "found", node: { document: { id: by.draft.value } } });
      });
    });
  }
});

__mergedSuite("create-join.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/create-join.db.test.ts.
  describeDraftTreeDb("a create joins a draft's document (postgres)", (start, db) => {
    it("answers joined, turns the draft's item into an edit, and replays unchanged, after a move and after a delete", async () => {
      const { s } = await start();
      const drafting = await s.work("Drafting", "draft");
      const hidden = await s.model(drafting).create("chapters/Withern", "The draft's Withern.");
      expect
        .soft(itemFor(await s.items(drafting), hidden).isNew, "hidden while a draft")
        .toBe(true);
      const device = crypto.randomUUID() as DocumentId;
      const joined = await s.writer.createInstant("chapters/Withern", device);
      const first = {
        status: "joined",
        documentId: hidden,
        address: { scheme: "manuscript", path: "chapters/Withern", name: "Withern" },
      };
      expect.soft(joined, "the draft's document, at its address").toEqual(first);
      expect
        .soft(await s.view("live").idAt("chapters/Withern"), "live, the draft's id")
        .toBe(hidden);
      expect
        .soft(itemFor(await s.items(drafting), hidden).isNew, "the review item is now an edit")
        .toBe(false);
      expect
        .soft(await db.select().from(documents).where(eq(documents.id, device)), "no twin row")
        .toEqual([]);
      const catalog = await createDrizzleContextCatalog(db).snapshot({
        kind: "project",
        projectId: s.project.id,
      });
      expect
        .soft(
          catalog.entries.find((entry) => entry.kind === "file" && entry.entryId === hidden),
          "the catalog entry names the id that forwarded to it",
        )
        .toMatchObject({ joinedFrom: [device] });
      expect
        .soft(await s.writer.createInstant("chapters/Withern", device), "replay")
        .toEqual(first);
      await s.writer.move("chapters/Withern", "chapters/Withern Keep");
      expect
        .soft(await s.writer.createInstant("chapters/Withern", device), "replay after a move")
        .toEqual({
          ...first,
          address: { scheme: "manuscript", path: "chapters/Withern Keep", name: "Withern Keep" },
        });
      await s.writer.delete("chapters/Withern Keep");
      expect
        .soft(await s.writer.createInstant("chapters/Withern", device), "replay after a delete")
        .toMatchObject({ status: "joined", documentId: hidden });
    });
    it("answers two overlapping replays with one forward and one document", async () => {
      const { s } = await start();
      const drafting = await s.work("Drafting", "draft");
      const hidden = await s.model(drafting).create("Withern", "The draft's Withern.");
      const device = crypto.randomUUID() as DocumentId;
      const answers = await Promise.all([
        s.writer.createInstant("Withern", device),
        s.writer.createInstant("Withern", device),
      ]);
      expect(answers).toEqual([
        expect.objectContaining({ status: "joined", documentId: hidden }),
        expect.objectContaining({ status: "joined", documentId: hidden }),
      ]);
      expect(await s.view("live").idAt("Withern")).toBe(hidden);
      expect(await db.select().from(documents).where(eq(documents.id, device))).toEqual([]);
    });
    it("leaves an untitled create off the names hidden documents hold", async () => {
      const { s } = await start();
      const drafting = await s.work("Drafting", "draft");
      const hidden = await s.model(drafting).create("Untitled 1", "The draft's.");
      const answer = await s.writer.createNameless(crypto.randomUUID() as DocumentId);
      expect.soft(answer).toMatchObject({ status: "created", name: "Untitled 2" });
      expect.soft(await s.view("live").idAt("Untitled 1"), "the draft's stays hidden").toBeNull();
      expect(itemFor(await s.items(drafting), hidden).isNew).toBe(true);
    });
  });
});

__mergedSuite("folder-normalization.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/tree/folder-normalization.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip(
      "live folder operations keep hidden nodes where their drafts expect them (postgres)",
      () => {},
    );
  } else {
    __mergedSuite(
      "live folder operations keep hidden nodes where their drafts expect them (postgres)",
      () => {
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
        async function idAt(
          scenario: DraftTreeScenario,
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
          expect
            .soft(await idAt(scenario, "live", "world/places/harbor"), "live does not")
            .toBeNull();
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
            expect
              .soft(await idAt(scenario, work, `kb://${path}`), `${path}: in its draft`)
              .toBe(id);
            expect.soft(await idAt(scenario, work, path), `${path}: not left behind`).toBeNull();
            expect
              .soft(await idAt(scenario, "live", `kb://${path}`), `${path}: not live`)
              .toBeNull();
          }
          expect.soft(await idAt(scenario, "live", "kb://notes/outline")).toBe(outline);
          expect.soft((await folder(notes)).locationVersion, "the moved folder's version").toBe(1n);
        });
        it("splits a nested hidden document off a folder moved out of user:// or into a Work's Scratch (F-3)", async () => {
          // Out of user:// into a project narrows which drafts may hold it (§8.3, D20); a
          // Work's Scratch is held by none.
          for (const into of ["project", "scratch"] as const) {
            const scenario = await start();
            const ascension = await scenario.work(`Ascension ${into}`, "draft");
            const origin = into === "project" ? "user://world" : "world";
            const stays =
              into === "project"
                ? scenario.project.sources.user
                : scenario.project.sources.manuscript;
            const destination =
              into === "project"
                ? "world"
                : `scratch://@${(await scenario.work("Notes", "direct")).slug}/world`;
            const map = await scenario.seedLive(`${origin}/places/map`);
            const places = await scenario.seedLiveFolder(`${origin}/places`);
            const harbor = await scenario
              .model(ascension)
              .create(`${origin}/places/harbor`, "Harbor.");
            expect
              .soft(
                await scenario.writer.move(origin, destination),
                `${destination}: the live move`,
              )
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
        it("answers a path two of a draft's documents share with the clash, never one of them (absorb)", async () => {
          const scenario = await start();
          const ascension = await scenario.work("Ascension", "draft");
          await scenario.seedLiveFolder("drafts");
          const first = await scenario.model(ascension).create("drafts/note", "First.");
          const second = await scenario.model(ascension).create("ideas/note", "Second.");
          expect
            .soft(await scenario.writer.move("drafts", "ideas"), "no live refusal")
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
          { first: "create" as const, at: "createInDraft.afterCandidateLock" as const },
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
          { first: "create" as const, at: "createInDraft.afterCandidateLock" as const },
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
      },
    );
  }
});

__mergedSuite("live-identity-observations.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/tree/live-identity-observations.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("identity moves and observations over hidden nodes (postgres)", () => {});
  } else {
    __mergedSuite("identity moves and observations over hidden nodes (postgres)", () => {
      // Creates publish catalog changes in their own transactions, so this suite commits.
      const db = createDb(DATABASE_URL, { max: 8 });
      afterAll(() => db.close());
      const runtimes = useComposedRuntimes(() => db);
      const tree = createTreeReader(db);
      beforeEach(async () => {
        await deleteDrizzleRows(db, [users]);
      });
      async function start() {
        const runtime = await runtimes.compose();
        const scenario = await draftTreeScenario(db, { runtime, runtimes });
        const { id: projectId, userId } = scenario.project;
        const ascension = await scenario.work("Ascension", "draft");
        const model = scenario.model(ascension);
        const port = runtime.ports.contextPorts.forProject(projectId, userId, new Map());
        const scope = { kind: "project" as const, projectId };
        const manuscript = scenario.project.sources.manuscript;
        async function namespaceVersion() {
          const [head] = await db
            .select({ version: contextAvailabilityHeads.namespaceGeneration })
            .from(contextAvailabilityHeads)
            .where(eq(contextAvailabilityHeads.authorityKey, `project:${projectId}`));
          return head?.version ?? 0n;
        }
        async function hiddenFolder(path: string) {
          const draft = await scenario.draftOf(ascension);
          const found = await tree.resolvePath(
            { kind: "draft", draftId: draft.id },
            { contextSourceId: manuscript, path },
          );
          if (found.kind !== "found" || found.node.kind !== "folder")
            throw new Error(`The draft holds no folder at ${path}`);
          const live = await tree.resolvePath(LIVE_TREE, {
            contextSourceId: manuscript,
            path,
          });
          expect(live.kind).toBe("not_found");
          return found.node.folder.id;
        }
        return {
          runtime,
          scenario,
          ascension,
          model,
          port,
          scope,
          manuscript,
          userId,
          namespaceVersion,
          hiddenFolder,
        };
      }
      it("refuses a writer's move into a folder only a draft holds as destination_missing", async () => {
        const s = await start();
        await s.model.create("lore/harbor", "The harbor.");
        const lore = await s.hiddenFolder("lore");
        const chapter = await s.scenario.writer.createDocument("chapter", "Chapter one.");
        const moved = await s.port.commitWriterLocation(
          "manuscript://chapter",
          "manuscript://lore/chapter",
          {
            origin: { type: "human", userId: s.userId },
            expected: { kind: "file", nodeId: chapter },
            destinationParent: { kind: "folder", folderId: lore },
          },
        );
        expect(moved).toMatchObject({
          ok: false,
          error: { code: "destination_missing" },
        });
        expect(await s.scenario.view("live").locate(chapter)).toBe("manuscript://chapter");
        await s.hiddenFolder("lore");
      });
      it("reveals a draft's hidden folder for anchored creation instead of making a second", async () => {
        const s = await start();
        await s.model.create("lore/harbor", "The harbor.");
        const lore = await s.hiddenFolder("lore");
        const chapter = await s.scenario.writer.createDocument("chapter", "Chapter one.");
        const moved = await s.port.commitWriterLocation(
          "manuscript://chapter",
          "manuscript://lore/chapter",
          {
            origin: { type: "human", userId: s.userId },
            expected: { kind: "file", nodeId: chapter },
            destinationParent: {
              kind: "root",
              scheme: "manuscript",
              owner: { workId: null },
              createFolders: ["lore"],
            },
          },
        );
        expect(moved).toMatchObject({
          ok: true,
          value: { destinationPath: "lore/chapter" },
        });
        const live = await tree.resolvePath(LIVE_TREE, {
          contextSourceId: s.manuscript,
          path: "lore",
        });
        expect(live).toMatchObject({
          kind: "found",
          node: { kind: "folder", folder: { id: lore } },
        });
        expect(await s.scenario.view("live").locate(chapter)).toBe("manuscript://lore/chapter");
      });
      /** Every catalog change since `cursor` that names a file, folder or source. */
      async function namespaceChanges(s: Awaited<ReturnType<typeof start>>, cursor: string) {
        const delta = await s.runtime.ports.contextCatalog.changes(s.scope, cursor);
        if (delta.kind !== "delta") throw new Error("Expected retained commits");
        return delta.commits
          .flatMap((commit) => commit.changes)
          .filter((change) => change.operation !== "upsert" || change.entry.kind !== "authority");
      }
      it("publishes no namespace observation for a draft's creates or tree change and a newer one for Apply's reveal", async () => {
        const s = await start();
        await s.scenario.writer.createDocument("chapter", "Chapter one.");
        await s.scenario.writer.createDocument("arc/opening", "The opening.");
        const before = await s.runtime.ports.contextCatalog.snapshot(s.scope);
        const versionBefore = await s.namespaceVersion();
        // Only the Work's pending count (an authority entry) may publish: a hidden-only
        // change allocates no namespace version and restamps no live file or folder.
        const harbor = await s.model.create("lore/harbor", "The harbor.");
        const lore = await s.hiddenFolder("lore");
        expect(await namespaceChanges(s, before.cursor)).toEqual([]);
        expect(await s.namespaceVersion()).toBe(versionBefore);
        const copied = await s.model.copy("chapter", "lore/chapter");
        expect(copied.isError).toBeFalsy();
        expect(await namespaceChanges(s, before.cursor)).toEqual([]);
        expect(await s.namespaceVersion()).toBe(versionBefore);
        const afterSnapshot = await s.runtime.ports.contextCatalog.snapshot(s.scope);
        expect(afterSnapshot.entries).toEqual(
          before.entries.map((entry) =>
            entry.kind === "authority"
              ? expect.objectContaining({ entryId: entry.entryId })
              : entry,
          ),
        );
        await s.scenario.apply(s.ascension, [harbor]);
        const versionAfter = await s.namespaceVersion();
        expect(versionAfter).toBeGreaterThan(versionBefore);
        const revealed = (await s.runtime.ports.contextCatalog.snapshot(s.scope)).entries.find(
          (entry) => entry.entryId === harbor,
        );
        expect(revealed).toMatchObject({
          kind: "file",
          observationVersion: String(versionAfter),
        });
        const changes = await namespaceChanges(s, before.cursor);
        expect(
          changes.some(
            (change) => change.operation === "upsert" && change.entry.entryId === harbor,
          ),
        ).toBe(true);
        expect(
          changes.some((change) => change.operation === "upsert" && change.entry.entryId === lore),
        ).toBe(true);
      });
      it("publishes nothing live, and names no hidden node, when a draft discards its creates", async () => {
        const s = await start();
        await s.scenario.writer.createDocument("chapter", "Chapter one.");
        await s.scenario.writer.createDocument("arc/opening", "The opening.");
        const harbor = await s.model.create("lore/harbor", "The harbor.");
        const lore = await s.hiddenFolder("lore");
        const before = await s.runtime.ports.contextCatalog.snapshot(s.scope);
        const versionBefore = await s.namespaceVersion();
        const known = new Set(
          (await db.select().from(contextCatalogCommits)).map((c) => c.commitId),
        );
        await s.scenario.discard(s.ascension, [harbor as DocumentId]);
        const published = (await db.select().from(contextCatalogCommits))
          .filter((commit) => !known.has(commit.commitId))
          .flatMap((commit) => commit.changes);
        expect(JSON.stringify(published)).not.toContain(harbor);
        expect(JSON.stringify(published)).not.toContain(lore);
        expect(await namespaceChanges(s, before.cursor)).toEqual([]);
        expect(await s.namespaceVersion()).toBe(versionBefore);
      });
    });
  }
});
