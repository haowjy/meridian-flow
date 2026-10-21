/**
 * Hidden-node lifecycle through the real commands (contract §6, §7, §12): a branch's create
 * is an empty hidden row its drafts share (C-2); a live create at a hidden path reveals it
 * and an aborted held write leaves live state alone (C-3); and the fences between a join,
 * a reveal and a last use hold in both orders (I-1, I-2, I-3).
 *
 * Outcomes are read through the tree's views. Rows are read only where no view can say
 * it: a tombstone (versus a hidden node nobody uses), and rows left naming one.
 */
import type { DocumentId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  branchTreeChanges,
  documents,
  documentYjsUpdates,
  folders,
  users,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { setTestHook } from "../../../shared/test-hooks.js";
import {
  type BranchTreeScenario,
  branchTreeScenario,
  type ScenarioWork,
} from "../../../test-support/branch-tree-scenario.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { createTestDocumentRemoval } from "../../../test-support/document-removal.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { race } from "../../../test-support/lock-interleave.js";
import { setLiveCreateHook } from "../adapters/context-fs/live-create.js";
import { endUse } from "./end-use.js";
import { createTreeReader, LIVE_TREE, type TreeView } from "./tree-view.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("hidden-node lifecycle (postgres)", () => {});
} else {
  describe("hidden-node lifecycle (postgres)", () => {
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
      const scenario = await branchTreeScenario(db, { runtime, runtimes });
      return { runtime, scenario };
    }

    /** The document's identity as the live view reads it. */
    async function liveStatus(id: string) {
      return (await tree.identityStatus(LIVE_TREE, [id as DocumentId])).get(id as DocumentId);
    }

    /** What `view` shows at a Manuscript path. */
    function at(scenario: BranchTreeScenario, view: TreeView, path: string) {
      return tree.resolvePath(view, { contextSourceId: scenario.project.sources.manuscript, path });
    }

    /** The folder id `view` shows at a Manuscript path, else null. */
    async function folderAt(scenario: BranchTreeScenario, view: TreeView, path: string) {
      const found = await at(scenario, view, path);
      return found.kind === "found" && found.node.kind === "folder" ? found.node.folder.id : null;
    }

    async function branchView(scenario: BranchTreeScenario, work: ScenarioWork): Promise<TreeView> {
      return { kind: "branch", branchId: (await scenario.branchOf(work)).id };
    }

    /** The documents the Work's branch created, as its tree state lists them. */
    async function createdIn(scenario: BranchTreeScenario, work: ScenarioWork) {
      const branch = await scenario.branchOf(work);
      return (await tree.treeState(branch.id))
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

    /** Every branch whose change row names the document, whatever the document's state. */
    async function rowsNaming(id: string) {
      return (
        await db
          .select({ branchId: branchTreeChanges.branchId })
          .from(branchTreeChanges)
          .where(eq(branchTreeChanges.nodeId, id))
      ).map((row) => row.branchId);
    }

    /** Every document row of the scenario named `name`, hidden rows and tombstones included. */
    async function _documentsNamed(scenario: BranchTreeScenario, name: string) {
      return db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.name, name),
            inArray(documents.contextSourceId, Object.values(scenario.project.sources)),
          ),
        );
    }

    /** Folders of the scenario named `name` that aren't tombstones, hidden ones included. */
    async function foldersNamed(scenario: BranchTreeScenario, name: string) {
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

    it("makes a branch's create an empty hidden row its drafts share (C-2)", async () => {
      const { runtime, scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");

      const kael = await scenario.model(ascension).create("lore/kael", "Kael, drafted.");
      const branch = await scenario.branchOf(ascension);
      expect
        .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live Yjs is never seeded")
        .toEqual({ ok: true, value: "" });
      expect
        .soft(await liveStatus(kael), "hidden, used by the branch")
        .toMatchObject({ kind: "hidden", usedBy: [{ branchId: branch.id }] });
      expect
        .soft(await folderAt(scenario, LIVE_TREE, "lore"), "its folder is in no live view")
        .toBeNull();
      expect
        .soft(
          await at(scenario, await branchView(scenario, ascension), "lore"),
          "the branch's hidden folder",
        )
        .toMatchObject({ kind: "found", node: { kind: "folder", folder: { hidden: true } } });
      expect.soft(await createdIn(scenario, ascension), "the branch's create").toEqual([kael]);
      expect
        .soft(await scenario.documentDraft(ascension, kael), "the document's draft")
        .toMatchObject({ draftId: expect.any(String) });
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

      // The same branch creating it again uses the document it already has.
      const again = await scenario.model(ascension).reply();
      const rewritten = await again.call("write", {
        command: "create",
        path: "manuscript://lore/kael",
        content: "Kael, again.",
        overwrite: true,
      });
      await again.save();
      expect.soft(rewritten.isError ?? false, "the overwrite succeeds").toBe(false);
      expect.soft(await createdIn(scenario, ascension), "one create per branch").toEqual([kael]);

      // Another branch's create at the path joins the same hidden document.
      const joined = await scenario.model(rival).create("lore/kael", "Kael, the rival's.");
      expect.soft(joined, "a second branch joins").toBe(kael);
      expect.soft(await createdIn(scenario, rival), "the rival's create").toEqual([kael]);
      expect
        .soft(await scenario.view("live").stat("lore/kael"), "still not live")
        .toMatchObject({ ok: false, error: { code: "not_found" } });
      expect
        .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live stays empty")
        .toEqual({ ok: true, value: "" });
    });

    // §6.3: a live create at a hidden node's path reveals it instead of making a twin.
    it("reveals the hidden document and its folder on an empty live create (C-3)", async () => {
      const { scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kael = await scenario.model(ascension).create("lore/kael", "Kael, drafted.");
      const lore = await folderAt(scenario, await branchView(scenario, ascension), "lore");

      expect(await scenario.writer.create("lore/kael")).toEqual({
        status: "created",
        documentId: kael,
      });
      expect.soft(await liveStatus(kael), "revealed").toMatchObject({ kind: "visible" });
      expect.soft(await folderAt(scenario, LIVE_TREE, "lore"), "its folder revealed").toBe(lore);
    });

    // The candidate's lease shows in the held-write abort case below.
    it("reveals the drafted document by path with the live create's content (C-3)", async () => {
      const { runtime, scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const harbor = await scenario.model(ascension).create("lore/harbor", "Harbor, drafted.");

      expect(
        await scenario.writer.create("lore/harbor", { content: "The writer's harbor." }),
      ).toEqual({ status: "created", documentId: harbor });
      const text = await runtime.ports.documentSync.readAsMarkdown(harbor);
      expect(text.ok && text.value, "the created content").toContain("The writer's harbor.");
    });

    it("reveals the hidden folder at the path on mkdir (C-3)", async () => {
      const { scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      await scenario.model(ascension).create("notes/first", "Notes, drafted.");
      const notes = await folderAt(scenario, await branchView(scenario, ascension), "notes");

      await scenario.writer.mkdir("notes");
      expect(notes, "the branch had the folder").not.toBeNull();
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
      const remove = setTestHook("checkpoint.afterAuthorityRead", async () => {
        const [row] = await currentDrizzleDb(db).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
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
          const rows = await db.execute<{ pid: number }>(sql`
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
    it.each([
      ["one first"],
      ["two first"],
    ])("tombstones a shared hidden ancestor when one batch ends sibling subtrees, %s", async (order) => {
      const { scenario } = await start();
      const drafting = await scenario.work("Drafting", "draft");
      const one = await scenario.seedHidden(drafting, "root/one/x");
      const two = await scenario.seedHidden(drafting, "root/two/y");
      const branch = await scenario.branchOf(drafting);
      const ids = order === "one first" ? [one, two] : [two, one];
      await runInDrizzleTransaction(db, () =>
        endUse(db, {
          removal: createTestDocumentRemoval(db),
          branchId: branch.id,
          documentIds: ids,
          actor: { cause: "repair" },
        }),
      );
      expect(await foldersNamed(scenario, "root"), "root pruned").toEqual([]);
      expect(await foldersNamed(scenario, "one")).toEqual([]);
      expect(await foldersNamed(scenario, "two")).toEqual([]);
    });

    // Each fence in both orders: the first run pauses at the hook holding its locks, the
    // second waits on them, then the first finishes.
    it.each([
      { first: "join" as const, at: "createInBranch.afterCandidateLock" as const, joinsX: true },
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
      const secondBranch = await scenario.branchOf(second);
      expect.soft(seconds === x, "the join takes x only while x is used").toBe(joinsX);
      expect
        .soft(await liveStatus(seconds), "the second's document, hidden for its one user")
        .toMatchObject({ kind: "hidden", usedBy: [{ branchId: secondBranch.id }] });
      expect.soft(await tombstoned(x), "x tombstoned only when nothing joined it").toBe(!joinsX);
      expect
        .soft(await rowsNaming(x), "no row names x but its user's")
        .toEqual(joinsX ? [secondBranch.id] : []);
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
      const created = by.reveal.value as { status: string; documentId?: string };
      expect.soft(created.status, "created").toBe("created");
      expect
        .soft(await at(scenario, LIVE_TREE, "lore/y"), "one live y, the created one")
        .toMatchObject({ kind: "found", node: { document: { id: created.documentId } } });
      expect.soft(created.documentId === y, "y revealed only while used").toBe(revealsY);
      expect.soft(await tombstoned(y), "y tombstoned only when not revealed").toBe(!revealsY);
    });

    it.each([
      "whole-branch",
    ] as const)("preserves a revealed draft-created document after %s Discard", async (_scope) => {
      const { runtime, scenario } = await start();
      const drafting = await scenario.work("Drafting", "draft");
      const path = "lore/y";
      const y = await scenario.model(drafting).create(path, "Drafted y.");
      const branch = await scenario.branchOf(drafting);
      expect(await liveStatus(y)).toMatchObject({
        kind: "hidden",
        usedBy: [{ branchId: branch.id }],
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
      expect(await liveStatus(y), "revealed before Discard").toMatchObject({ kind: "visible" });
      const liveText = "The writer's live y.";
      await scenario.writer.write(path, liveText);
      const storageBefore = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, y))
        .orderBy(documentYjsUpdates.id);
      expect(storageBefore, "the writer's live write is durable").not.toEqual([]);

      await scenario.discard(drafting, "all");

      expect.soft(await liveStatus(y), "still visible").toMatchObject({ kind: "visible" });
      expect.soft(await tombstoned(y), "not deleted").toBe(false);
      expect.soft(await scenario.view("live").idAt(path), "same document id").toBe(y);
      expect.soft(await scenario.view("live").text(path), "live text intact").toBe(`${liveText}\n`);
      expect.soft(await rowsNaming(y), "no branch tree row remains").toEqual([]);
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
      { first: "branch" as const, at: "createInBranch.afterCandidateLock" as const },
      { first: "live" as const, at: "createLive.afterCandidateLock" as const },
    ])("leaves one document when a live create meets a branch create at one path, $first first (I-3)", async ({
      first,
      at: point,
    }) => {
      const { scenario } = await start();
      const drafting = await scenario.work("Drafting", "draft");
      const { bWaited, by } = await race(
        db,
        {
          branch: () => scenario.model(drafting).create("lore/z", "Drafted z."),
          live: () => scenario.writer.create("lore/z"),
        },
        first,
        point,
      );
      expect.soft(bWaited, "the second waits at the fence").toBe(true);
      expect.soft(by.live.ok, "the live create settles").toBe(true);
      if (!by.branch.ok) throw by.branch.error;
      expect
        .soft(await at(scenario, LIVE_TREE, "lore/z"), "one document, live, the branch's")
        .toMatchObject({ kind: "found", node: { document: { id: by.branch.value } } });
    });
  });
}
