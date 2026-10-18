/**
 * A reply's drafted writes and the branch they land in (contract §2.5, ledger K-1, K-2): a
 * read never makes a branch, draft or peer; the first write does. A save whose branch closed
 * under it refuses that document stale and never provisions a new branch (B9); and a save
 * or an immediate write and Discard all serialize, in both orders,
 * without deadlock (V2-H2, §14), the losing write refusing as a stale save does.
 */
import type { DocumentId, WorkId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { branches, documentDrafts, draftWriteJournal, users } from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  type BranchTreeScenario,
  branchTreeScenario,
  type ScenarioReply,
  type ScenarioWork,
} from "../../test-support/branch-tree-scenario.js";
import { useComposedRuntimes } from "../../test-support/composed-runtime.js";
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
    // Saves and closes race on several connections, so this suite commits.
    const db = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      return branchTreeScenario(db, { runtime, runtimes });
    }

    /** A live chapter the writer made, with one paragraph. */
    async function liveChapter(scenario: BranchTreeScenario, name: string): Promise<DocumentId> {
      const created = await scenario.writer.create(`manuscript://${name}`, {
        content: "Writer opening.",
      });
      if (created.status !== "created" || !created.documentId) {
        throw new Error(`the writer's ${name} was not created`);
      }
      return created.documentId as DocumentId;
    }

    async function branchesOf(work: ScenarioWork) {
      return db
        .select({ id: branches.id, status: branches.status })
        .from(branches)
        .where(eq(branches.originWorkId, work.id as WorkId))
        .orderBy(asc(branches.createdAt));
    }

    async function draftsOf(documentId: DocumentId) {
      return db
        .select({
          kind: documentDrafts.kind,
          status: documentDrafts.status,
          branchId: documentDrafts.branchId,
        })
        .from(documentDrafts)
        .where(eq(documentDrafts.documentId, documentId))
        .orderBy(asc(documentDrafts.kind));
    }

    /** One reply that read the chapter and staged a drafted replacement in it. */
    async function staged(
      scenario: BranchTreeScenario,
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

    /** The documents the save refused: a denial, or a write the branch's end turned away (receipted). */
    const refusedIn = (result: unknown) => [
      ...((result as SaveResult).refused ?? []).map(({ documentId }) => documentId),
      ...((result as SaveResult).receipts ?? [])
        .filter(({ receipt }) => receipt.result.status === "invalid_write")
        .map(({ documentId }) => documentId),
    ];

    /** The agent rows saved into this branch's draft on the document. */
    async function savedRows(branchId: string, documentId: DocumentId) {
      const drafts = await db
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(
          and(
            eq(documentDrafts.branchId, branchId),
            eq(documentDrafts.documentId, documentId),
            eq(documentDrafts.kind, "work_draft"),
          ),
        );
      if (drafts.length === 0) return [];
      return db
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .where(
          and(
            inArray(
              draftWriteJournal.draftId,
              drafts.map(({ id }) => id),
            ),
            eq(draftWriteJournal.source, "agent"),
          ),
        );
    }

    it("K-2: a read in a draft-mode Work with no branch makes no branch, draft or peer; the first write does", async () => {
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
      expect.soft(await branchesOf(work), "the read made no branch").toEqual([]);
      expect.soft(await draftsOf(chapter), "and no draft or peer").toEqual([]);

      const write = await reply.call("write", {
        command: "replace",
        path: "manuscript://ch1.md",
        find: "Writer opening.",
        content: "Model draft.",
      });
      expect(write.isError, JSON.stringify(write.output)).toBeFalsy();
      const made = await branchesOf(work);
      expect
        .soft(made, "the first write made the branch")
        .toEqual([{ id: expect.any(String), status: "active" }]);
      const branchId = made[0]?.id;
      expect.soft(await draftsOf(chapter), "and the branch's draft and peer").toEqual([
        { kind: "thread_peer", status: "active", branchId },
        { kind: "work_draft", status: "active", branchId },
      ]);
      const saved = await reply.save();
      expect.soft(refusedIn(saved), "the save keeps it").toEqual([]);
      expect.soft(await savedRows(branchId ?? "", chapter), "in the draft").toHaveLength(1);
    });

    it("K-1: a save whose branch closed refuses that document stale and never provisions a new branch for it; a save and a close serialize in both orders", async () => {
      const scenario = await start();

      // B9: the reply staged, a whole Discard closed the branch, then the reply saves.
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
        .soft(await branchesOf(closedFirst), "no branch is provisioned for the write")
        .toEqual([{ id: expect.any(String), status: "closed" }]);
      expect
        .soft(
          (await draftsOf(chapter)).map(({ status }) => status),
          "the closed branch's drafts stay closed",
        )
        .toEqual(["closed", "closed"]);
      const scratch = await scenario.view(closedFirst).read("scratch://notes.md");
      expect.soft(scratch.ok, "the reply's other document saved (D29, D42)").toBe(true);

      // V2-H2, one order: the close commits first; the save then finds its branch closed.
      const closeFirst = await scenario.work("Close commits first", "draft");
      const second = await liveChapter(scenario, "close-commits-first.md");
      const waitingSave = await staged(scenario, closeFirst, "close-commits-first.md");
      const closeThenSave = await interleave(
        db,
        () => scenario.discard(closeFirst, "all"),
        "discard.beforeRetirement",
        () => waitingSave.save(),
        { waitMs: 300 },
      );
      expect.soft(closeThenSave.a, "the close finishes").toMatchObject({ ok: true });
      expect.soft(closeThenSave.b, "then saves").toMatchObject({ ok: true });
      expect
        .soft(closeThenSave.b.ok && refusedIn(closeThenSave.b.value), "refusing it stale")
        .toEqual([second]);
      expect
        .soft(await branchesOf(closeFirst), "without a new branch")
        .toEqual([{ id: expect.any(String), status: "closed" }]);

      // The other order: the save holds its Work lock; the close waits for it.
      const saveFirst = await scenario.work("Save commits first", "draft");
      const third = await liveChapter(scenario, "save-commits-first.md");
      const holdingSave = await staged(scenario, saveFirst, "save-commits-first.md");
      const [branchBefore] = await branchesOf(saveFirst);
      const saveThenClose = await interleave(
        db,
        () => holdingSave.save(),
        "save.afterWorkLock",
        () => scenario.discard(saveFirst, "all"),
        { waitMs: 300 },
      );
      expect.soft(saveThenClose.a, "the save finishes").toMatchObject({ ok: true });
      expect
        .soft(saveThenClose.a.ok && refusedIn(saveThenClose.a.value), "keeping its document")
        .toEqual([]);
      expect.soft(saveThenClose.b, "then closes").toMatchObject({ ok: true });
      expect
        .soft(await savedRows(branchBefore?.id ?? "", third), "the save landed in the draft")
        .toHaveLength(1);
      expect
        .soft(await branchesOf(saveFirst), "which the close then closed")
        .toEqual([{ id: branchBefore?.id, status: "closed" }]);

      // §14: an immediate write and a close race on branch state alone, neither waiting on
      // the other. A write that captured its branch before the close committed is refused; one
      // that commits while the close has not is closed with the branch. Neither outlives it.
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
            ? await interleave(db, write, "draft.beforeAccess", close, { waitMs: 300 })
            : await interleave(db, close, "discard.beforeCommitScope", write, { waitMs: 300 });
        const wrote = first === "write" ? run.a : run.b;
        const closed = first === "write" ? run.b : run.a;
        expect.soft(closed, `${first} first: the close finishes`).toMatchObject({ ok: true });
        if (first === "write") {
          expect
            .soft(wrote, "write first: the write finishes without landing in the closed branch")
            .toMatchObject({
              ok: true,
              value: { isError: true, result: { status: "invalid_write" } },
            });
          expect
            .soft(
              wrote.ok && JSON.stringify(wrote.value),
              "write first: and tells the model its drafts were discarded, not a crash",
            )
            .toContain("draft changed");
        } else {
          expect
            .soft(wrote, "close first: the write commits ahead of the close's commit")
            .toMatchObject({ ok: true, value: { result: { status: "success" } } });
        }
        expect
          .soft(await branchesOf(work), `${first} first: the branch closes, none is made`)
          .toEqual([{ id: expect.any(String), status: "closed" }]);
        expect
          .soft(
            (await draftsOf(chapter)).map(({ status }) => status),
            `${first} first: no draft outlives the close`,
          )
          .toEqual(["closed", "closed"]);
      }
    });
  });
}
