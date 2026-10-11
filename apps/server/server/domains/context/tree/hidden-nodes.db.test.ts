/**
 * Hidden-node lifecycle through the real commands (contract §6, §7, §12): a draft's create
 * is an empty hidden row its drafts share (C-2); a live create at a hidden path reveals it,
 * by path or by id, and an aborted held write leaves live state alone (C-3); the fences
 * between a join, a reveal and a last use hold in both orders (I-1, I-2, I-3); and a
 * reveal by id lands where the writer asks, never from a source a split or move just
 * changed (I-6).
 *
 * Outcomes are read through the tree's views. Rows are read only where no view can say
 * it: a tombstone (versus a hidden node nobody uses), and rows left naming one.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  contextSources,
  documents,
  documentYjsUpdates,
  draftTreeChanges,
  folders,
  users,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioWork,
} from "../../../test-support/draft-tree-scenario.js";
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
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      return { runtime, scenario };
    }

    /** The document's identity as the live view reads it. */
    async function liveStatus(id: string) {
      return (await tree.identityStatus(LIVE_TREE, [id as DocumentId])).get(id as DocumentId);
    }

    /** What `view` shows at a Manuscript path. */
    function at(scenario: DraftTreeScenario, view: TreeView, path: string) {
      return tree.resolvePath(view, { contextSourceId: scenario.project.sources.manuscript, path });
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

    /** Every document row of the scenario named `name`, hidden rows and tombstones included. */
    async function documentsNamed(scenario: DraftTreeScenario, name: string) {
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

      const kael = await scenario.model(ascension).create("lore/kael.md", "Kael, drafted.");
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
        path: "manuscript://lore/kael.md",
        content: "Kael, again.",
        overwrite: true,
      });
      await again.save();
      expect.soft(rewritten.isError ?? false, "the overwrite succeeds").toBe(false);
      expect.soft(await createdIn(scenario, ascension), "one create per draft").toEqual([kael]);

      // Another draft's create at the path joins the same hidden document.
      const joined = await scenario.model(rival).create("lore/kael.md", "Kael, the rival's.");
      expect.soft(joined, "a second draft joins").toBe(kael);
      expect.soft(await createdIn(scenario, rival), "the rival's create").toEqual([kael]);
      expect
        .soft(await scenario.view("live").stat("lore/kael.md"), "still not live")
        .toMatchObject({ ok: false, error: { code: "not_found" } });
      expect
        .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live stays empty")
        .toEqual({ ok: true, value: "" });
    });

    // §6.3: a live create at a hidden node's path reveals it instead of making a twin.
    it("reveals the hidden document and its folder on an empty live create (C-3)", async () => {
      const { scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const kael = await scenario.model(ascension).create("lore/kael.md", "Kael, drafted.");
      const lore = await folderAt(scenario, await draftView(scenario, ascension), "lore");

      expect(await scenario.writer.create("lore/kael.md")).toEqual({
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
      const harbor = await scenario.model(ascension).create("lore/harbor.md", "Harbor, drafted.");

      expect(
        await scenario.writer.create("lore/harbor.md", { content: "The writer's harbor." }),
      ).toEqual({ status: "created", documentId: harbor });
      const text = await runtime.ports.documentSync.readAsMarkdown(harbor);
      expect(text.ok && text.value, "the created content").toContain("The writer's harbor.");
    });

    it("reveals the hidden folder at the path on mkdir (C-3)", async () => {
      const { scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      await scenario.model(ascension).create("notes/first.md", "Notes, drafted.");
      const notes = await folderAt(scenario, await draftView(scenario, ascension), "notes");

      await scenario.writer.mkdir("notes");
      expect(notes, "the draft had the folder").not.toBeNull();
      expect(await folderAt(scenario, LIVE_TREE, "notes"), "that folder, live").toBe(notes);
    });

    it("leaves durable and warm live state alone when a held write fails before commit (C-3)", async () => {
      const { runtime, scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const tide = await scenario.model(ascension).create("tide.md", "Tide, drafted.");
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
          scenario.writer.create("tide.md", { content: "The writer's tide." }),
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

    // §12.2 step 5: a batch's last uses prune every hidden ancestor left empty, whichever
    // document of the batch comes first. An unused hidden folder is in no view, so only its
    // row tells a tombstone from a leftover.
    it.each([
      ["one first"],
      ["two first"],
    ])("tombstones a shared hidden ancestor when one batch ends sibling subtrees, %s", async (order) => {
      const { scenario } = await start();
      const drafting = await scenario.work("Drafting", "draft");
      const one = await scenario.seedHidden(drafting, "root/one/x.md");
      const two = await scenario.seedHidden(drafting, "root/two/y.md");
      const draft = await scenario.draftOf(drafting);
      const ids = order === "one first" ? [one, two] : [two, one];
      await runInDrizzleTransaction(db, () => endUse(db, { draftId: draft.id, documentIds: ids }));
      expect(await foldersNamed(scenario, "root"), "root pruned").toEqual([]);
      expect(await foldersNamed(scenario, "one")).toEqual([]);
      expect(await foldersNamed(scenario, "two")).toEqual([]);
    });

    // §6.4: Create by id reveals only a hidden identity of the caller's project, found by
    // its physical row (not the draft's address).
    it.each([
      {
        name: "a hidden document its draft places in another source",
        async arrange(scenario: DraftTreeScenario) {
          const drafting = await scenario.work("Drafting", "draft");
          const id = await scenario.model(drafting).create("draft-place/x.md", "Placed elsewhere.");
          // The draft has it in KB; the row stays in Manuscript.
          await db
            .update(draftTreeChanges)
            .set({ contextSourceId: scenario.project.sources.kb, parentFolderId: null })
            .where(eq(draftTreeChanges.nodeId, id));
          return { id, destination: undefined };
        },
      },
      {
        name: "a hidden document revealed into a Work's unprovisioned Scratch",
        async arrange(scenario: DraftTreeScenario) {
          const drafting = await scenario.work("Drafting", "draft");
          const id = await scenario.model(drafting).create("cold/x.md", "Revealed cold.");
          // A direct Work whose Scratch no create has provisioned yet: discovery mustn't need it.
          return { id, destination: await scenario.work("Cold Scratch", "direct") };
        },
      },
    ])("Create by id reveals $name (C-3)", async ({ arrange }) => {
      const { scenario } = await start();
      const { id, destination } = await arrange(scenario);
      const created = await scenario.writer.create("revealed.md", {
        documentId: id,
        ...(destination ? { inScratchOf: destination } : {}),
      });
      expect(created).toEqual({ status: "created", documentId: id });
      const [scratch] = destination
        ? await db
            .select({ id: contextSources.id })
            .from(contextSources)
            .where(eq(contextSources.workId, destination.id))
        : [];
      expect(await liveStatus(id)).toMatchObject({
        kind: "visible",
        address: {
          contextSourceId: scratch?.id ?? scenario.project.sources.manuscript,
          path: "revealed.md",
        },
      });
    });

    // §6.4: and never mints a row with an id it can't reveal.
    it.each([
      {
        name: "another account's hidden document",
        async arrange() {
          const { scenario: victim } = await start();
          const theirs = await victim.work("Theirs", "draft");
          const id = await victim.model(theirs).create("secret.md", "Their secret.");
          const untouched = {
            kind: "hidden",
            address: { contextSourceId: victim.project.sources.manuscript },
          };
          return { id, untouched, tombstone: false };
        },
      },
      {
        name: "an id no document has",
        async arrange() {
          return { id: randomUUID() as DocumentId, untouched: { kind: "gone" }, tombstone: null };
        },
      },
      {
        name: "a tombstone",
        async arrange(scenario: DraftTreeScenario) {
          const drafting = await scenario.work("Drafting", "draft");
          const id = await scenario.model(drafting).create("gone/x.md", "Discarded.");
          await scenario.discard(drafting, [id]);
          return { id, untouched: { kind: "gone" }, tombstone: true };
        },
      },
    ])("Create by id refuses $name (C-3)", async ({ arrange }) => {
      const { scenario } = await start();
      const { id, untouched, tombstone } = await arrange(scenario);
      expect(await scenario.writer.create("revealed.md", { documentId: id })).toEqual({
        status: "conflict",
      });
      // No view can say "no row anywhere": a hidden row or one in another source counts.
      expect(await documentsNamed(scenario, "revealed"), "nothing minted").toEqual([]);
      expect(await liveStatus(id), "the identity is untouched").toMatchObject(untouched);
      expect(await tombstoned(id), "its row, as it was").toBe(tombstone);
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
      const x = await scenario.model(firstWork).create("lore/x.md", "First's x.");
      const { bWaited, by } = await race(
        db,
        {
          join: () => scenario.model(second).create("lore/x.md", "Second's x."),
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
      const y = await scenario.model(drafting).create("lore/y.md", "Drafted y.");
      const { bWaited, by } = await race(
        db,
        {
          reveal: () => scenario.writer.create("lore/y.md"),
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
        .soft(await at(scenario, LIVE_TREE, "lore/y.md"), "one live y, the created one")
        .toMatchObject({ kind: "found", node: { document: { id: created.documentId } } });
      expect.soft(created.documentId === y, "y revealed only while used").toBe(revealsY);
      expect.soft(await tombstoned(y), "y tombstoned only when not revealed").toBe(!revealsY);
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
          draft: () => scenario.model(drafting).create("lore/z.md", "Drafted z."),
          live: () => scenario.writer.create("lore/z.md"),
        },
        first,
        point,
      );
      expect.soft(bWaited, "the second waits at the fence").toBe(true);
      expect.soft(by.live.ok, "the live create settles").toBe(true);
      if (!by.draft.ok) throw by.draft.error;
      expect
        .soft(await at(scenario, LIVE_TREE, "lore/z.md"), "one document, live, the draft's")
        .toMatchObject({ kind: "found", node: { document: { id: by.draft.value } } });
    });

    it.each([
      { operation: "split", first: "reveal", at: "revealById.afterDiscovery", waits: false },
      { operation: "move", first: "reveal", at: "revealById.afterDiscovery", waits: false },
      { operation: "split", first: "live", at: "split.beforeRepoint", waits: true },
      { operation: "move", first: "live", at: "moves.beforeInstall", waits: true },
    ] as const)("reveals by id only at a revalidated source when a $operation races it, $first first (I-6)", async ({
      operation,
      first,
      at: point,
      waits,
    }) => {
      const { scenario } = await start();
      const drafting = await scenario.work("Drafting", "draft");
      await scenario.seedLive("kb://atlas/coast.md");
      const isle = await scenario.model(drafting).create("kb://atlas/isle.md", "Isle.");
      const { bWaited, by } = await race(
        db,
        {
          reveal: () => scenario.writer.create("isle.md", { documentId: isle }),
          live: () =>
            operation === "split"
              ? scenario.writer.delete("kb://atlas")
              : scenario.writer.move("kb://atlas", "unfiled://atlas"),
        },
        first,
        point,
      );
      // Paused after discovery the reveal holds nothing; the live operation's sources
      // make the reveal wait.
      expect.soft(bWaited, "the reveal waits only behind the live operation").toBe(waits);
      expect.soft(by.live.ok && by.live.value, "live op").toMatchObject({ ok: true });
      expect
        .soft(by.reveal.ok && by.reveal.value, "revealed that document")
        .toEqual({ status: "created", documentId: isle });
      expect.soft(await liveStatus(isle), "where the writer asked").toMatchObject({
        kind: "visible",
        address: { uri: "manuscript://isle.md" },
      });
    });
  });
}
