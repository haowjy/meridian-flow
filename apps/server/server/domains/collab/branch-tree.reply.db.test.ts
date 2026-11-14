/**
 * A reply's drafted writes and the branch they land in (contract §2.5, ledger K-1, K-2): a read never makes a branch, draft or peer; the first write does.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - lazy branch, draft, and peer provisioning on first write (kb/wiki/architecture/collaboration/drafts-and-branches.md#where-a-write-goes)
 */

import type { DocumentId, WorkId } from "@meridian/contracts";
import { toolContentText } from "@meridian/contracts/threads";
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
    async function _staged(
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
      expect(write.isError, JSON.stringify(write.content)).toBeFalsy();
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

    it("K-2: a read in a draft-mode Work with no branch makes no branch or draft; the first write does", async () => {
      const scenario = await start();
      const work = await scenario.work("Ascension", "draft");
      const chapter = await liveChapter(scenario, "ch1.md");

      const reply = await scenario.model(work).reply();
      const read = await reply.call("read", { path: "manuscript://ch1.md" });
      expect.soft(read.isError, "the read answers").toBeFalsy();
      expect
        .soft(read.result, "it names the version it asked for")
        .toMatchObject({ read: { version: "draft" } });
      expect
        .soft(String(toolContentText(read.content)), "its content is the live base")
        .toContain("Writer opening.");
      expect.soft(await branchesOf(work), "the read made no branch").toEqual([]);
      expect.soft(await draftsOf(chapter), "and no draft").toEqual([]);

      const write = await reply.call("write", {
        command: "replace",
        path: "manuscript://ch1.md",
        find: "Writer opening.",
        content: "Model draft.",
      });
      expect(write.isError, JSON.stringify(write.content)).toBeFalsy();
      const made = await branchesOf(work);
      expect
        .soft(made, "the first write made the branch")
        .toEqual([{ id: expect.any(String), status: "active" }]);
      const branchId = made[0]?.id;
      expect
        .soft(await draftsOf(chapter), "and the branch's draft")
        .toEqual([{ kind: "work_draft", status: "active", branchId }]);
      const saved = await reply.save();
      expect.soft(refusedIn(saved), "the save keeps it").toEqual([]);
      expect.soft(await savedRows(branchId ?? "", chapter), "in the draft").toHaveLength(1);
    });
  });
}
