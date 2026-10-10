/**
 * Hidden-node lifecycle through the real commands (contract §6, §7, §12): a draft's create
 * is an empty hidden row its drafts share (C-2); a live create at a hidden path reveals it,
 * by path or by id, and an aborted held write leaves live state alone (C-3); the fences
 * between a join, a reveal and a last use hold in both orders (I-1, I-2, I-3); and a
 * reveal by id never lands from a source a split or move just changed (I-6).
 */
import { randomUUID } from "node:crypto";
import type { DocumentId, WorkId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  contextSources,
  documentBranches,
  documents,
  documentYjsUpdates,
  draftTreeChanges,
  folders,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
} from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { setLiveCreateHook } from "../adapters/context-fs/live-create.js";
import { endUse } from "./end-use.js";

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

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      return { runtime, scenario };
    }

    async function row(id: string) {
      const [found] = await db
        .select({
          id: documents.id,
          hidden: documents.hidden,
          deletedAt: documents.deletedAt,
          contextSourceId: documents.contextSourceId,
          folderId: documents.folderId,
          name: documents.name,
        })
        .from(documents)
        .where(eq(documents.id, id as DocumentId));
      if (!found) throw new Error(`no document ${id}`);
      return found;
    }

    async function folderNamed(scenario: DraftTreeScenario, name: string) {
      return db
        .select({ id: folders.id, hidden: folders.hidden, deletedAt: folders.deletedAt })
        .from(folders)
        .where(
          and(
            eq(folders.name, name),
            isNull(folders.deletedAt),
            inArray(folders.contextSourceId, Object.values(scenario.project.sources)),
          ),
        );
    }

    async function createdBy(id: string) {
      return db
        .select({ draftId: draftTreeChanges.draftId })
        .from(draftTreeChanges)
        .where(eq(draftTreeChanges.nodeId, id));
    }

    /** The scenario's documents named `name`, deleted ones left out, hidden ones included. */
    async function rowsNamed(scenario: DraftTreeScenario, name: string) {
      return db
        .select({ id: documents.id, hidden: documents.hidden })
        .from(documents)
        .where(
          and(
            eq(documents.name, name),
            isNull(documents.deletedAt),
            inArray(documents.contextSourceId, Object.values(scenario.project.sources)),
          ),
        );
    }

    async function workRevision(id: WorkId) {
      const [found] = await db
        .select({ revision: works.entityRevision })
        .from(works)
        .where(eq(works.id, id));
      return found?.revision ?? 0n;
    }

    it("makes a draft's create an empty hidden row its drafts share (C-2)", async () => {
      const { runtime, scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const rival = await scenario.work("Rival", "draft");
      const revisionBefore = await workRevision(ascension.id);

      const kael = await scenario.model(ascension).create("lore/kael.md", "Kael, drafted.");
      const draft = await scenario.draftOf(ascension);
      expect
        .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live Yjs is never seeded")
        .toEqual({ ok: true, value: "" });
      expect.soft(await row(kael), "hidden row").toMatchObject({ hidden: true, deletedAt: null });
      expect
        .soft(await folderNamed(scenario, "lore"), "hidden folder")
        .toEqual([expect.objectContaining({ hidden: true })]);
      expect
        .soft(await createdBy(kael), "the draft's created row")
        .toEqual([{ draftId: draft.id }]);
      expect
        .soft(
          await db
            .select({ id: documentBranches.id })
            .from(documentBranches)
            .where(
              and(
                eq(documentBranches.documentId, kael),
                eq(documentBranches.kind, "work_draft"),
                eq(documentBranches.workId, ascension.id),
              ),
            ),
          "the draft's branch",
        )
        .toHaveLength(1);
      expect
        .soft(await workRevision(ascension.id), "pending projection enrolled")
        .toBeGreaterThan(revisionBefore);

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
      expect.soft(await createdBy(kael), "no second row in one draft").toHaveLength(1);

      // Another draft's create at the path joins the same hidden document.
      const joined = await scenario.model(rival).create("lore/kael.md", "Kael, the rival's.");
      expect.soft(joined, "a second draft joins").toBe(kael);
      expect.soft(await createdBy(kael), "each draft's row").toHaveLength(2);
      expect.soft(await rowsNamed(scenario, "kael"), "one document").toHaveLength(1);
      expect
        .soft(await scenario.view("live").stat("lore/kael.md"), "still not live")
        .toMatchObject({ ok: false, error: { code: "not_found" } });
      expect
        .soft(await runtime.ports.documentSync.readAsMarkdown(kael), "live stays empty")
        .toEqual({ ok: true, value: "" });
    });

    it("reveals instead of inserting a twin, by path and by id, and aborts a held write cleanly (C-3)", async () => {
      const { runtime, scenario } = await start();
      const ascension = await scenario.work("Ascension", "draft");
      const model = scenario.model(ascension);

      // An empty live create at a hidden document's path reveals it.
      const kael = await model.create("lore/kael.md", "Kael, drafted.");
      expect
        .soft(await scenario.writer.create("lore/kael.md"), "empty create reveals")
        .toEqual({ status: "created", documentId: kael });
      expect.soft(await row(kael), "revealed").toMatchObject({ hidden: false, deletedAt: null });
      expect
        .soft(await folderNamed(scenario, "lore"), "its folder revealed")
        .toEqual([expect.objectContaining({ hidden: false })]);
      expect.soft(await rowsNamed(scenario, "kael"), "no twin").toHaveLength(1);

      // With content: the candidate's lease first, then the held write (B3).
      const harbor = await model.create("lore/harbor.md", "Harbor, drafted.");
      expect
        .soft(
          await scenario.writer.create("lore/harbor.md", { content: "The writer's harbor." }),
          "create with content reveals",
        )
        .toEqual({ status: "created", documentId: harbor });
      const harborText = await runtime.ports.documentSync.readAsMarkdown(harbor);
      expect
        .soft(harborText.ok && harborText.value, "the created content")
        .toContain("The writer's harbor.");

      // Create by id reveals exactly that document at the requested path, across sources.
      const isle = await model.create("kb://atlas/isle.md", "Isle, drafted.");
      expect
        .soft(await scenario.writer.create("isle.md", { documentId: isle }), "create by id")
        .toEqual({ status: "created", documentId: isle });
      expect.soft(await row(isle), "revealed where the writer asked").toMatchObject({
        hidden: false,
        contextSourceId: scenario.project.sources.manuscript,
        folderId: null,
        name: "isle",
      });

      // mkdir at a hidden folder's path reveals that folder.
      await model.create("notes/first.md", "Notes, drafted.");
      const [hiddenNotes] = await folderNamed(scenario, "notes");
      await scenario.writer.mkdir("notes");
      expect
        .soft(await folderNamed(scenario, "notes"), "mkdir reveals, no twin")
        .toEqual([{ id: hiddenNotes?.id, hidden: false, deletedAt: null }]);

      // A failure after the held admission and before commit leaves durable and warm live
      // state exactly as they were.
      const tide = await model.create("tide.md", "Tide, drafted.");
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
      expect.soft(await row(tide), "still hidden").toMatchObject({ hidden: true, deletedAt: null });
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
    // document of the batch comes first.
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
      expect(await folderNamed(scenario, "root"), "root pruned").toEqual([]);
      expect(await folderNamed(scenario, "one")).toEqual([]);
      expect(await folderNamed(scenario, "two")).toEqual([]);
    });

    // §6.4: Create by id reveals only a hidden identity of the caller's project, found by
    // its physical row (not the draft's address), and never mints a row with the id.
    it.each([
      {
        name: "another account's hidden document",
        expected: "conflict" as const,
        async arrange() {
          const { scenario: victim } = await start();
          const theirs = await victim.work("Theirs", "draft");
          const id = await victim.model(theirs).create("secret.md", "Their secret.");
          return {
            id,
            untouched: { hidden: true, contextSourceId: victim.project.sources.manuscript },
          };
        },
      },
      {
        name: "a hidden document its draft places in another source",
        expected: "created" as const,
        async arrange(scenario: DraftTreeScenario) {
          const drafting = await scenario.work("Drafting", "draft");
          const id = await scenario.model(drafting).create("draft-place/x.md", "Placed elsewhere.");
          // The draft has it in KB; the row stays in Manuscript.
          await db
            .update(draftTreeChanges)
            .set({ contextSourceId: scenario.project.sources.kb, parentFolderId: null })
            .where(eq(draftTreeChanges.nodeId, id));
          return { id, untouched: null };
        },
      },
      {
        name: "a hidden document revealed into a Work's unprovisioned Scratch",
        expected: "created" as const,
        destination: "scratch" as const,
        async arrange(scenario: DraftTreeScenario) {
          const drafting = await scenario.work("Drafting", "draft");
          const id = await scenario.model(drafting).create("cold/x.md", "Revealed cold.");
          return { id, untouched: null };
        },
      },
      {
        name: "an id no document has",
        expected: "conflict" as const,
        async arrange() {
          return { id: randomUUID() as DocumentId, untouched: null };
        },
      },
      {
        name: "a tombstone",
        expected: "conflict" as const,
        async arrange(scenario: DraftTreeScenario) {
          const drafting = await scenario.work("Drafting", "draft");
          const id = await scenario.model(drafting).create("gone/x.md", "Discarded.");
          await scenario.discard(drafting, [id]);
          return { id, untouched: { hidden: true, deletedAt: expect.any(Date) } };
        },
      },
    ])("Create by id with $name: $expected (C-3)", async (testCase) => {
      const { arrange, expected } = testCase;
      const { scenario } = await start();
      const { id, untouched } = await arrange(scenario);
      // A direct Work whose Scratch no create has provisioned yet: discovery mustn't need it.
      const destination =
        "destination" in testCase ? await scenario.work("Cold Scratch", "direct") : undefined;
      const created = await scenario.writer.create("revealed.md", {
        documentId: id,
        ...(destination ? { inScratchOf: destination } : {}),
      });
      if (expected === "created") {
        expect(created).toEqual({ status: "created", documentId: id });
        const [scratch] = destination
          ? await db
              .select({ id: contextSources.id })
              .from(contextSources)
              .where(eq(contextSources.workId, destination.id))
          : [];
        expect(await row(id)).toMatchObject({
          hidden: false,
          contextSourceId: scratch?.id ?? scenario.project.sources.manuscript,
          name: "revealed",
        });
        return;
      }
      expect(created).toEqual({ status: "conflict" });
      expect(await rowsNamed(scenario, "revealed"), "nothing minted").toEqual([]);
      if (untouched) expect(await row(id), "the identity is untouched").toMatchObject(untouched);
      else expect(await db.select().from(documents).where(eq(documents.id, id))).toEqual([]);
    });

    it("never joins a tombstone nor orphans a node when a join meets a last use (I-1)", async () => {
      for (const order of ["join first", "last use first"] as const) {
        const { scenario } = await start();
        const first = await scenario.work(`First ${order}`, "draft");
        const second = await scenario.work(`Second ${order}`, "draft");
        const x = await scenario.model(first).create("lore/x.md", "First's x.");
        const join = () => scenario.model(second).create("lore/x.md", "Second's x.");
        const discard = () => scenario.discard(first, [x]);
        const settled =
          order === "join first"
            ? await scenario.interleave(join, "createInDraft.afterCandidateLock", discard)
            : await scenario.interleave(discard, "endUse.afterRevalidate", join);
        expect.soft(settled.bWaited, `${order}: the second waits at the fence`).toBe(true);
        const [joined, discarded] =
          order === "join first" ? [settled.a, settled.b] : [settled.b, settled.a];
        expect.soft(joined.ok, `${order}: join settles`).toBe(true);
        expect.soft(discarded.ok, `${order}: discard settles`).toBe(true);
        const secondDraft = await scenario.draftOf(second);
        const secondsDocument = joined.ok ? (joined.value as string) : null;
        if (order === "join first") {
          expect.soft(secondsDocument, `${order}: joined x`).toBe(x);
          expect.soft(await row(x), `${order}: x kept for its user`).toMatchObject({
            hidden: true,
            deletedAt: null,
          });
          expect
            .soft(await createdBy(x), `${order}: only the second draft uses x`)
            .toEqual([{ draftId: secondDraft.id }]);
        } else {
          expect.soft(secondsDocument, `${order}: a new document`).not.toBe(x);
          expect.soft((await row(x)).deletedAt, `${order}: x tombstoned`).toBeInstanceOf(Date);
          expect.soft(await createdBy(x), `${order}: nothing uses the tombstone`).toEqual([]);
          if (secondsDocument) {
            expect
              .soft(await row(secondsDocument), `${order}: the new one hidden`)
              .toMatchObject({ hidden: true, deletedAt: null });
          }
        }
      }
    });

    it("either reveals or tombstones-and-inserts when a reveal meets a last use (I-2)", async () => {
      for (const order of ["reveal first", "last use first"] as const) {
        const { scenario } = await start();
        const drafting = await scenario.work(`Drafting ${order}`, "draft");
        const y = await scenario.model(drafting).create("lore/y.md", "Drafted y.");
        const reveal = () => scenario.writer.create("lore/y.md");
        const discard = () => scenario.discard(drafting, [y]);
        const settled =
          order === "reveal first"
            ? await scenario.interleave(reveal, "createLive.afterCandidateLock", discard)
            : await scenario.interleave(discard, "endUse.afterRevalidate", reveal);
        expect.soft(settled.bWaited, `${order}: the second waits at the fence`).toBe(true);
        const [revealed, discarded] =
          order === "reveal first" ? [settled.a, settled.b] : [settled.b, settled.a];
        expect.soft(revealed.ok, `${order}: create settles`).toBe(true);
        expect.soft(discarded.ok, `${order}: discard settles`).toBe(true);
        const created = revealed.ok
          ? (revealed.value as { status: string; documentId?: string })
          : null;
        expect.soft(created?.status, `${order}: created`).toBe("created");
        const live = await rowsNamed(scenario, "y");
        expect
          .soft(
            live.filter((each) => !each.hidden),
            `${order}: one live y`,
          )
          .toHaveLength(1);
        if (order === "reveal first") {
          expect.soft(created?.documentId, `${order}: revealed y`).toBe(y);
          expect.soft(await row(y), `${order}: y live`).toMatchObject({
            hidden: false,
            deletedAt: null,
          });
        } else {
          expect.soft(created?.documentId, `${order}: a fresh row`).not.toBe(y);
          expect.soft((await row(y)).deletedAt, `${order}: y tombstoned`).toBeInstanceOf(Date);
        }
      }
    });

    it("leaves one document when a live create meets a draft create at one path (I-3)", async () => {
      for (const order of ["draft first", "live first"] as const) {
        const { scenario } = await start();
        const drafting = await scenario.work(`Drafting ${order}`, "draft");
        const draftCreate = () => scenario.model(drafting).create("lore/z.md", "Drafted z.");
        const liveCreate = () => scenario.writer.create("lore/z.md");
        const settled =
          order === "draft first"
            ? await scenario.interleave(draftCreate, "createInDraft.afterCandidateLock", liveCreate)
            : await scenario.interleave(liveCreate, "createLive.afterCandidateLock", draftCreate);
        expect.soft(settled.bWaited, `${order}: the second waits at the fence`).toBe(true);
        expect.soft(settled.a.ok, `${order}: first settles`).toBe(true);
        expect.soft(settled.b.ok, `${order}: second settles`).toBe(true);
        const rows = await rowsNamed(scenario, "z");
        expect
          .soft(rows, `${order}: one document, live`)
          .toEqual([expect.objectContaining({ hidden: false })]);
        const drafted = order === "draft first" ? settled.a : settled.b;
        expect
          .soft(drafted.ok && drafted.value, `${order}: the draft writes that document`)
          .toBe(rows[0]?.id);
      }
    });
    it("reveals by id only at a revalidated source when a split or move races it (I-6)", async () => {
      for (const operation of ["split", "move"] as const) {
        for (const order of ["reveal first", "live operation first"] as const) {
          const label = `${operation}, ${order}`;
          const { scenario } = await start();
          const drafting = await scenario.work(`Drafting ${label}`, "draft");
          await scenario.seedLive("kb://atlas/coast.md");
          const isle = await scenario.model(drafting).create("kb://atlas/isle.md", "Isle.");
          const reveal = () => scenario.writer.create("isle.md", { documentId: isle });
          const live = () =>
            operation === "split"
              ? scenario.writer.delete("kb://atlas")
              : scenario.writer.move("kb://atlas", "unfiled://atlas");
          const settled =
            order === "reveal first"
              ? await scenario.interleave(reveal, "revealById.afterDiscovery", live)
              : await scenario.interleave(
                  live,
                  operation === "split" ? "split.beforeRepoint" : "moves.beforeInstall",
                  reveal,
                );
          if (order === "live operation first") {
            expect.soft(settled.bWaited, `${label}: the reveal waits for the sources`).toBe(true);
          }
          const [revealed, operated] =
            order === "reveal first" ? [settled.a, settled.b] : [settled.b, settled.a];
          expect
            .soft(operated.ok && operated.value, `${label}: live op`)
            .toMatchObject({ ok: true });
          expect
            .soft(revealed.ok && revealed.value, `${label}: revealed that document`)
            .toEqual({ status: "created", documentId: isle });
          expect.soft(await row(isle), `${label}: where the writer asked`).toMatchObject({
            hidden: false,
            deletedAt: null,
            contextSourceId: scenario.project.sources.manuscript,
            folderId: null,
            name: "isle",
          });
          expect.soft(await rowsNamed(scenario, "isle"), `${label}: no twin`).toHaveLength(1);
        }
      }
    });
  });
}
