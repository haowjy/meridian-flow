/**
 * The tree halves of a Work's Apply and Discard, over Postgres: what a writer sees land in live,
 * what a Discard leaves, and the Work's pending count (design section 5). The records are made
 * the way the server makes them (`treeListStore.submit`), so the rows are the replay's.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a discarded drafted create keeps its `documents` row until the retention job purges it
 */

import { randomUUID } from "node:crypto";
import type { BranchId, DocumentId, UserId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  branchTreeNodes,
  contextSources,
  documentDrafts,
  documents,
  projects,
  treeNodes,
  users,
  works,
} from "@meridian/database/schema";
import { LIVE, lastSettlements, listRecords, type TreeWriter } from "@meridian/project-tree";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestRemovalDeps } from "../../test-support/document-removal.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../test-support/tree-seed.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createTreeReader } from "../context/tree/tree-view.js";
import { createDrizzleApplyClick } from "./adapters/drizzle-apply-click.js";
import { createDrizzleBranchDiscard } from "./adapters/drizzle-branch-discard.js";
import { createDrizzleBranchTreeState } from "./adapters/drizzle-branch-tree-state.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import { createBranchDiscard } from "./domain/branch-discard.js";
import { createBranches } from "./domain/branches.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

describe.skipIf(!enabled || !process.env.DATABASE_URL)(
  "Apply and Discard of a Work's tree (postgres)",
  () => {
    const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
    afterAll(() => db.close());

    const USER = randomUUID() as UserId;
    const PROJECT = randomUUID();
    const SOURCE = randomUUID();
    const WORK = randomUUID();
    const AGENT = `agent:${randomUUID()}/${randomUUID()}`;
    let branchId: BranchId;

    const { draftClose, treeLists } = createTestRemovalDeps(db);
    const workProjection = createTestWorkProjectionMutation(db);
    const workBranches = createBranches({
      store: createDrizzleBranchStore(db),
      boundary: createDrizzleBranchWriteBoundary(db, workProjection),
    });
    const tree = createTreeReader(db);
    const branchTree = createDrizzleBranchTreeState(db, tree);
    const seed = treeSeeder(db);
    const pending = createDrizzleWorkBranchPendingStore(db);
    const apply = createDrizzleApplyClick(db, {
      workProjection,
      branches: workBranches,
      // A tree-only click reads no text: nothing below the tree half is reached.
      coordinator: {} as never,
      live: {} as never,
      liveCoordinator: {} as never,
      treeLists,
      tree,
      branchTree,
      close: draftClose,
      onCommitted: async () => {},
      measured: () => {},
    });
    const discard = createBranchDiscard({
      branches: workBranches,
      store: createDrizzleBranchDiscard(db, {
        close: draftClose,
        branches: workBranches,
        workProjection,
        treeLists,
      }),
      holdRetirement: draftClose.holdRetirement,
    });

    const viewOf = () => ({ draft: branchId as string });

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.insert(users).values(conformanceUserValues(USER, "apply-discard"));
      await db.insert(projects).values({
        id: PROJECT,
        userId: USER,
        name: "Project",
        slug: "project",
      });
      await db.insert(contextSources).values({
        id: SOURCE,
        projectId: PROJECT,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(works).values({
        id: WORK,
        projectId: PROJECT,
        createdByUserId: USER,
        name: "Work",
        handle: "w1",
      });
      const [branch] = await db
        .insert(branches)
        .values({ projectId: PROJECT, originWorkId: WORK, createdBy: USER })
        .returning({ id: branches.id });
      branchId = (branch as { id: BranchId }).id;
    });

    /** A server change to the project's list: what the writer or another Work did. */
    async function submit<T>(make: (writer: TreeWriter) => T): Promise<T> {
      const { result } = await treeLists.submit({
        lists: [await treeListOfSource(db, SOURCE)],
        make: ([{ writer }]) => make(writer),
      });
      return result;
    }

    function envelope(commandId: string) {
      return {
        commandId,
        accountId: USER,
        kind: "apply_click" as const,
        branchId,
        digest: commandId,
      };
    }

    async function click(documentId: DocumentId, revision: string | null, restore = false) {
      const commandId = randomUUID();
      return apply.apply(
        {
          branchId,
          documentId,
          envelope: envelope(commandId),
          request: {
            commandId,
            baseViewDelta: [],
            groupIds: [],
            tree: { revision },
            ...(restore ? { restore: true as const } : {}),
          },
        } as never,
        { kind: "tree", branchId, tree: { revision } },
      );
    }

    async function revisionOf(documentId: DocumentId) {
      const [item] = await branchTree.read(branchId, [], [documentId]);
      return item?.revision ?? null;
    }

    const liveRow = async (id: string) =>
      (await db.select().from(treeNodes).where(eq(treeNodes.id, id)))[0];
    const branchRow = async (id: string) =>
      (
        await db
          .select()
          .from(branchTreeNodes)
          .where(and(eq(branchTreeNodes.id, id), eq(branchTreeNodes.branchId, branchId)))
      )[0];
    async function pendingCount() {
      const rows = await pending.countPendingByOwners({ workIds: [WORK], rootThreadIds: [] });
      return rows.find((row) => row.branchId === branchId)?.count ?? 0;
    }

    it("Apply lands a drafted create: it is live and the Work's row is gone", async () => {
      const id = (await seed.document(SOURCE, "Arc/chapter.md", {
        view: viewOf(),
        actor: AGENT,
      })) as DocumentId;
      expect(await liveRow(id)).toBeUndefined();
      expect(await branchRow(id)).toMatchObject({ existsOnlyInDraft: true, deleted: false });
      const [item] = await branchTree.read(branchId, [], [id]);
      expect(item).toMatchObject({
        origin: "created",
        isNew: true,
        change: "created",
        pending: true,
      });

      const answer = await click(id, item?.revision ?? null);
      expect(answer.status).toBe("applied");
      expect(await liveRow(id)).toMatchObject({ name: "chapter", trashRecord: null });
      expect(await branchRow(id)).toBeUndefined();
    });

    it("Apply lands a drafted rename, move and delete of live documents", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      const b = (await seed.document(SOURCE, "beta.md")) as DocumentId;
      const c = (await seed.document(SOURCE, "gamma.md")) as DocumentId;
      const folder = await seed.folder(SOURCE, "Arc", { view: viewOf(), actor: AGENT });
      await submit((writer) => {
        writer.rename(viewOf(), AGENT, a, "alpha two");
        writer.move(viewOf(), AGENT, b, folder);
        writer.delete(viewOf(), AGENT, c);
      });
      // Live shows none of it until the clicks.
      expect(await liveRow(a)).toMatchObject({ name: "alpha" });
      expect(await branchRow(c)).toMatchObject({ deleted: true });

      expect((await click(a, await revisionOf(a))).status).toBe("applied");
      expect(await liveRow(a)).toMatchObject({ name: "alpha two" });

      expect((await click(b, await revisionOf(b))).status).toBe("applied");
      expect(await liveRow(b)).toMatchObject({ parentId: folder });
      expect(await liveRow(folder)).toMatchObject({ kind: "folder", name: "Arc" });

      expect((await click(c, await revisionOf(c))).status).toBe("applied");
      expect((await liveRow(c))?.trashRecord).not.toBeNull();
      expect(await branchRow(c)).toBeUndefined();
    });

    it("answers `changed` for a revision the writer did not see, and lands nothing", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "first"));
      const seen = await revisionOf(a);
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "second"));
      expect((await click(a, seen)).status).toBe("changed");
      expect(await liveRow(a)).toMatchObject({ name: "alpha" });
      expect(await branchRow(a)).toMatchObject({ name: "second" });
    });

    it("asks before bringing back a document live deleted, and restores it on `restore`", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "kept"));
      await submit((writer) => writer.delete(LIVE, "system", a));
      const revision = await revisionOf(a);
      expect((await click(a, revision)).status).toBe("needs_restore");
      expect((await liveRow(a))?.trashRecord).not.toBeNull();

      const answer = await click(a, revision, true);
      expect(answer).toMatchObject({ status: "applied", restored: true });
      expect(await liveRow(a)).toMatchObject({ name: "kept", trashRecord: null });
    });

    it("counts a Work's pending documents from its rows, and a Discard takes its item off", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      const made = (await seed.document(SOURCE, "made.md", {
        view: viewOf(),
        actor: AGENT,
      })) as DocumentId;
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "renamed"));
      expect(await pendingCount()).toBe(2);

      const result = await discard.discardItems({
        branchId,
        userId: USER,
        selection: {
          kind: "items",
          items: [{ documentId: made, origin: "created", ends: "item" }],
        },
      });
      expect(result).toMatchObject({ status: "discarded", closed: [made] });
      // The discarded create is in no view and keeps its document row for retention.
      expect(await liveRow(made)).toBeUndefined();
      expect(await branchRow(made)).toBeUndefined();
      expect(await db.select().from(documents).where(eq(documents.id, made))).toHaveLength(1);
      // Its record is settled discarded in the list; the rename is still pending.
      const verdict = await submit((writer) => {
        const create = listRecords(writer.doc).find(
          (record) => record.type === "create" && record.node === made,
        );
        return create ? lastSettlements(writer.doc).get(create.id)?.to : undefined;
      });
      expect(verdict).toBe("discarded");
      expect(await branchRow(a)).toMatchObject({ name: "renamed" });
      expect(await pendingCount()).toBe(1);
    });

    it("keeps a live-deleted document in the Work's tree while the Work has a text draft of it", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await db.insert(documentDrafts).values({
        id: randomUUID(),
        documentId: a,
        kind: "work_draft",
        branchId,
        state: Buffer.alloc(0),
        stateVector: Buffer.alloc(0),
      });
      expect(await branchRow(a)).toBeUndefined();
      await submit((writer) => writer.delete(LIVE, "system", a));
      // Live has it in Trash; the Work's tree still shows it, and review lists it as deleted live.
      expect((await liveRow(a))?.trashRecord).not.toBeNull();
      expect(await branchRow(a)).toMatchObject({ deleted: false, existsOnlyInDraft: false });
      const [item] = await branchTree.read(branchId, [a]);
      expect(item).toMatchObject({ deletedLive: true, pending: true });
      expect(await pendingCount()).toBe(1);
    });

    it("applies a drafted create into the account's user:// list, not the project's", async () => {
      const personal = randomUUID();
      const userSource = randomUUID();
      await db.insert(projects).values({
        id: personal,
        userId: USER,
        name: "Personal",
        slug: "personal",
        isPersonal: true,
      });
      await db.insert(contextSources).values({
        id: userSource,
        projectId: personal,
        name: "User",
        slug: "user",
        scope: "project",
      });
      const id = (await seed.document(userSource, "notes.md", {
        view: viewOf(),
        actor: AGENT,
      })) as DocumentId;
      expect(await branchRow(id)).toMatchObject({ existsOnlyInDraft: true });
      const [item] = await branchTree.read(branchId, [], [id]);
      expect((await click(id, item?.revision ?? null)).status).toBe("applied");
      const [account] = await db
        .select({ listId: users.treeListId })
        .from(users)
        .where(eq(users.id, USER));
      expect(await liveRow(id)).toMatchObject({ listId: account?.listId, trashRecord: null });
      expect(await branchRow(id)).toBeUndefined();
    });

    it("a whole Discard settles every pending record and closes the branch", async () => {
      const made = (await seed.document(SOURCE, "made.md", {
        view: viewOf(),
        actor: AGENT,
      })) as DocumentId;
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await submit((writer) => writer.delete(viewOf(), AGENT, a));
      const result = await discard.discardItems({
        branchId,
        userId: USER,
        selection: { kind: "whole" },
      });
      expect(result).toMatchObject({ status: "discarded", branchClosed: true });
      expect(await liveRow(a)).toMatchObject({ trashRecord: null });
      expect(await liveRow(made)).toBeUndefined();
      expect((await db.select().from(documents).where(eq(documents.id, made)))[0]).toBeDefined();
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      expect(branch?.status).toBe("closed");
    });

    it("refuses a Discard of an item the Work has nothing left on", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await expect(
        discard.discardItems({
          branchId,
          userId: USER,
          selection: { kind: "items", items: [{ documentId: a, origin: "edited", ends: "tree" }] },
        }),
      ).rejects.toThrow(/nothing left to discard/);
    });
  },
);
