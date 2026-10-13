/**
 * A reply's drafted writes and the draft they land in (contract §2.5, ledger K-1, K-2): a
 * read never makes a draft or a peer, the first write does; a save whose draft closed
 * under it refuses that document stale and never provisions a new draft (B9); and a save
 * or an immediate write and Discard all serialize on their branch leases, in both orders,
 * without deadlock (V2-H2, §14), the losing write refusing as a stale save does.
 */
import type { DocumentId, WorkId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { branchWriteJournal, documentBranches, drafts, users } from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useComposedRuntimes } from "../../test-support/composed-runtime.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioReply,
  type ScenarioWork,
} from "../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { interleave } from "../../test-support/lock-interleave.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

type SaveResult = {
  status: string;
  refused?: { documentId: string; message: string }[];
  receipts?: { documentId: string; receipt: { result: { status: string; message?: string } } }[];
};

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("a reply's drafted writes (postgres)", () => {});
} else {
  describe("a reply's drafted writes (postgres)", () => {
    // Saves, closes and their leases run on several connections, so this suite commits.
    const db = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      return draftTreeScenario(db, { runtime, runtimes });
    }

    /** A live chapter the writer made, with one paragraph. */
    async function liveChapter(scenario: DraftTreeScenario, name: string): Promise<DocumentId> {
      const created = await scenario.writer.create(`manuscript://${name}`, {
        content: "Writer opening.",
      });
      if (created.status !== "created" || !created.documentId) {
        throw new Error(`the writer's ${name} was not created`);
      }
      return created.documentId as DocumentId;
    }

    async function draftsOf(work: ScenarioWork) {
      return db
        .select({ id: drafts.id, status: drafts.status })
        .from(drafts)
        .where(eq(drafts.originWorkId, work.id as WorkId))
        .orderBy(asc(drafts.createdAt));
    }

    async function branchesOf(documentId: DocumentId) {
      return db
        .select({
          kind: documentBranches.kind,
          status: documentBranches.status,
          draftId: documentBranches.draftId,
        })
        .from(documentBranches)
        .where(eq(documentBranches.documentId, documentId))
        .orderBy(asc(documentBranches.kind));
    }

    /** One reply that read the chapter and staged a drafted replacement in it. */
    async function staged(
      scenario: DraftTreeScenario,
      work: ScenarioWork,
      name: string,
    ): Promise<ScenarioReply> {
      const reply = await scenario.model(work).reply();
      const path = `manuscript://${name}`;
      expect((await reply.call("read", { path })).isError).toBeFalsy();
      const write = await reply.call("write", {
        command: "replace",
        path,
        find: "Writer opening.",
        content: "Staged draft.",
      });
      expect(write.isError, JSON.stringify(write.output)).toBeFalsy();
      return reply;
    }

    /** The documents the save refused: a denial, or a write the draft's end turned away (receipted). */
    const refusedIn = (result: unknown) => [
      ...((result as SaveResult).refused ?? []).map(({ documentId }) => documentId),
      ...((result as SaveResult).receipts ?? [])
        .filter(({ receipt }) => receipt.result.status === "invalid_write")
        .map(({ documentId }) => documentId),
    ];

    /** The agent rows saved into this draft's branch on the document. */
    async function savedRows(draftId: string, documentId: DocumentId) {
      const branches = await db
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.draftId, draftId),
            eq(documentBranches.documentId, documentId),
            eq(documentBranches.kind, "work_draft"),
          ),
        );
      if (branches.length === 0) return [];
      return db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(
          and(
            inArray(
              branchWriteJournal.branchId,
              branches.map(({ id }) => id),
            ),
            eq(branchWriteJournal.source, "agent"),
          ),
        );
    }

    it("K-2: a read in a draft-mode Work with no draft makes no draft and no peer; the first write does", async () => {
      const scenario = await start();
      const work = await scenario.work("Ascension", "draft");
      const chapter = await liveChapter(scenario, "ch1.md");

      const reply = await scenario.model(work).reply();
      const read = await reply.call("read", { path: "manuscript://ch1.md" });
      expect.soft(read.isError, "the read answers").toBeFalsy();
      expect
        .soft(read.result, "it names the version it asked for")
        .toMatchObject({ read: { version: "draft" } });
      expect.soft(String(read.output), "its content is the live base").toContain("Writer opening.");
      expect.soft(await draftsOf(work), "the read made no draft").toEqual([]);
      expect.soft(await branchesOf(chapter), "and no branch or peer").toEqual([]);

      const write = await reply.call("write", {
        command: "replace",
        path: "manuscript://ch1.md",
        find: "Writer opening.",
        content: "Model draft.",
      });
      expect(write.isError, JSON.stringify(write.output)).toBeFalsy();
      const made = await draftsOf(work);
      expect
        .soft(made, "the first write made the draft")
        .toEqual([{ id: expect.any(String), status: "active" }]);
      const draftId = made[0]?.id;
      expect.soft(await branchesOf(chapter), "and the draft's branch and peer").toEqual([
        { kind: "thread_peer", status: "active", draftId },
        { kind: "work_draft", status: "active", draftId },
      ]);
      const saved = await reply.save();
      expect.soft(refusedIn(saved), "the save keeps it").toEqual([]);
      expect.soft(await savedRows(draftId ?? "", chapter), "in the draft").toHaveLength(1);
    });

    it("K-1: a save whose draft closed refuses that document stale and never re-drafts it; a save and a close serialize on their leases in both orders", async () => {
      const scenario = await start();

      // B9: the reply staged, a whole Discard closed the draft, then the reply saves.
      const closedFirst = await scenario.work("Closed first", "draft");
      const chapter = await liveChapter(scenario, "closed-first.md");
      const reply = await staged(scenario, closedFirst, "closed-first.md");
      const notes = await reply.call("write", {
        command: "create",
        path: "scratch://notes.md",
        content: "Scratch notes.",
      });
      expect(notes.isError, JSON.stringify(notes.output)).toBeFalsy();
      await scenario.discard(closedFirst, "all");
      const saved = await reply.save();
      expect.soft(refusedIn(saved), "the drafted document refuses stale").toEqual([chapter]);
      expect
        .soft(String((saved as SaveResult).receipts?.[0]?.receipt.result.message), "and says why")
        .toContain("discarded this draft");
      expect
        .soft(await draftsOf(closedFirst), "no draft is provisioned for the write")
        .toEqual([{ id: expect.any(String), status: "closed" }]);
      expect
        .soft(
          (await branchesOf(chapter)).map(({ status }) => status),
          "the closed draft's branches stay closed",
        )
        .toEqual(["closed", "closed"]);
      const scratch = await scenario.view(closedFirst).read("scratch://notes.md");
      expect.soft(scratch.ok, "the reply's other document saved (D29, D42)").toBe(true);

      // V2-H2, one order: the close holds every branch lease; the save waits for them.
      const leasedByClose = await scenario.work("Close leases first", "draft");
      const second = await liveChapter(scenario, "close-leases-first.md");
      const waitingSave = await staged(scenario, leasedByClose, "close-leases-first.md");
      const closeThenSave = await interleave(
        db,
        () => scenario.discard(leasedByClose, "all"),
        "discard.afterLeases",
        () => waitingSave.save(),
        { waitMs: 300 },
      );
      expect.soft(closeThenSave.a, "the close finishes").toMatchObject({ ok: true });
      expect.soft(closeThenSave.bBlocked, "the save waited on the leases").toBe(true);
      expect.soft(closeThenSave.b, "then saves").toMatchObject({ ok: true });
      expect
        .soft(closeThenSave.b.ok && refusedIn(closeThenSave.b.value), "refusing it stale")
        .toEqual([second]);
      expect
        .soft(await draftsOf(leasedByClose), "without a new draft")
        .toEqual([{ id: expect.any(String), status: "closed" }]);

      // The other order: the save holds its leases and its Work lock; the close waits.
      const leasedBySave = await scenario.work("Save leases first", "draft");
      const third = await liveChapter(scenario, "save-leases-first.md");
      const holdingSave = await staged(scenario, leasedBySave, "save-leases-first.md");
      const [draftBefore] = await draftsOf(leasedBySave);
      const saveThenClose = await interleave(
        db,
        () => holdingSave.save(),
        "save.afterWorkLock",
        () => scenario.discard(leasedBySave, "all"),
        { waitMs: 300 },
      );
      expect.soft(saveThenClose.a, "the save finishes").toMatchObject({ ok: true });
      expect
        .soft(saveThenClose.a.ok && refusedIn(saveThenClose.a.value), "keeping its document")
        .toEqual([]);
      expect.soft(saveThenClose.bBlocked, "the close waited on the leases").toBe(true);
      expect.soft(saveThenClose.b, "then closes").toMatchObject({ ok: true });
      expect
        .soft(await savedRows(draftBefore?.id ?? "", third), "the save landed in the draft")
        .toHaveLength(1);
      expect
        .soft(await draftsOf(leasedBySave), "which the close then closed")
        .toEqual([{ id: draftBefore?.id, status: "closed" }]);

      // §14: an immediate write takes its peer's and draft branch's leases in the close's
      // order, so either may hold them first and the other waits; neither waits in a cycle.
      for (const first of ["write", "close"] as const) {
        const work = await scenario.work(`Immediate, ${first} first`, "draft");
        const name = `immediate-${first}-first.md`;
        const chapter = await liveChapter(scenario, name);
        await (await staged(scenario, work, name)).save();
        const write = () =>
          scenario.model(work).now("write", {
            command: "replace",
            path: `manuscript://${name}`,
            find: "Staged draft.",
            content: "Immediate draft.",
          });
        const close = () => scenario.discard(work, "all");
        const run =
          first === "write"
            ? await interleave(db, write, "access.afterLeases", close, { waitMs: 300 })
            : await interleave(db, close, "discard.afterLeases", write, { waitMs: 300 });
        expect.soft(run.bBlocked, `${first} first: the other waits on its leases`).toBe(true);
        const wrote = first === "write" ? run.a : run.b;
        const closed = first === "write" ? run.b : run.a;
        expect.soft(closed, `${first} first: the close finishes`).toMatchObject({ ok: true });
        expect
          .soft(wrote, `${first} first: the write finishes without landing in the closed draft`)
          .toMatchObject({
            ok: true,
            value: { isError: true, result: { status: "invalid_write" } },
          });
        expect
          .soft(
            wrote.ok && JSON.stringify(wrote.value),
            `${first} first: and tells the model its draft was closed, not a crash`,
          )
          .toContain("draft changed");
        expect
          .soft(await draftsOf(work), `${first} first: the draft closes, none is made`)
          .toEqual([{ id: expect.any(String), status: "closed" }]);
        expect
          .soft(
            (await branchesOf(chapter)).map(({ status }) => status),
            `${first} first: no branch outlives the close`,
          )
          .toEqual(["closed", "closed"]);
      }
    });
  });
}
