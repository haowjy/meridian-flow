/**
 * The tree halves of a Work's Apply and Discard, over Postgres: what a writer sees land in live,
 * what a Discard leaves, and the Work's pending count (design section 5). The records are made
 * the way the server makes them (`treeListStore.submit`), so the rows are the replay's.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a discarded drafted create keeps its `documents` row until the retention job purges it
 */

import { randomUUID } from "node:crypto";
import type { BranchId, CommandId, DocumentId, UserId } from "@meridian/contracts";
import type { DiscardCommandResult } from "@meridian/contracts/branches";
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
import * as Y from "yjs";
import { lockDocumentMutation } from "../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { accountUserSource } from "../../test-support/branch-tree-seeds.js";
import { createTestRemovalDeps } from "../../test-support/document-removal.js";
import { createTestDraftCoordinator } from "../../test-support/draft-coordinator.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { interleave } from "../../test-support/lock-interleave.js";
import { treeListOfSource, treeSeeder } from "../../test-support/tree-seed.js";
import { createTreeReader } from "../context/tree/tree-view.js";
import { createWorkProjectionMutation } from "../projects/adapters/work-projection-mutation.js";
import { createDrizzleApplyClick } from "./adapters/drizzle-apply-click.js";
import { createDrizzleBranchDiscard } from "./adapters/drizzle-branch-discard.js";
import { createDrizzleBranchTreeState } from "./adapters/drizzle-branch-tree-state.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleDocumentCommands } from "./adapters/drizzle-document-commands.js";
import { draftsStillClosedBy } from "./adapters/drizzle-draft-close.js";
import { createReopenDrafts } from "./adapters/drizzle-reopen-drafts.js";
import { createDrizzleUndoDiscard } from "./adapters/drizzle-undo-discard.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import { createApplyClickService, type TreeCut } from "./domain/apply-click.js";
import { createBranchDiscard } from "./domain/branch-discard.js";
import { createBranches } from "./domain/branches.js";
import { createDraftRetirement } from "./domain/draft-retirement.js";
import { createUndoDiscardService } from "./domain/undo-discard.js";

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
    /** A Discard is a command: its claim, and the answer it stores. */
    const asCommand = () => ({
      envelope: {
        commandId: randomUUID() as CommandId,
        accountId: USER,
        projectId: PROJECT as never,
        kind: "discard" as const,
        digest: randomUUID(),
      },
      result: () => ({ status: "discarded", branchId }) as DiscardCommandResult,
    });
    /** The owners the boundary woke at commit: what another tab's list is told to read again. */
    const woken: string[] = [];
    const workProjection = createWorkProjectionMutation({
      db,
      draftOwnerHints: {
        publishDraftOwnerHints: (hints) => woken.push(...hints.map((hint) => hint.owner)),
      },
      pendingCounts: createDrizzleWorkBranchPendingStore(db),
    });
    const branchStore = createDrizzleBranchStore(db);
    const workBranches = createBranches({
      store: branchStore,
      boundary: createDrizzleBranchWriteBoundary(db, workProjection),
    });
    const coordinator = createTestDraftCoordinator(db, {
      close: draftClose,
      treeLists,
      workProjection,
      branches: branchStore,
    });
    const tree = createTreeReader(db);
    const branchTree = createDrizzleBranchTreeState(db, tree);
    const seed = treeSeeder(db);
    const pending = createDrizzleWorkBranchPendingStore(db);
    // A tree-only click reads no text: no text base is read or replayed.
    const reopen = createReopenDrafts(db, {
      coordinator,
      close: draftClose,
      treeLists,
      workProjection,
      scheduleLivePull: () => {},
    });
    const apply = createDrizzleApplyClick(db, {
      workProjection,
      branches: workBranches,
      coordinator,
      reopen,
      live: {} as never,
      liveCoordinator: {} as never,
      treeLists,
      tree,
      branchTree,
      close: draftClose,
      onCommitted: async () => {},
      merged: () => {},
      measured: () => {},
      answeredWithoutLanding: () => {},
    });
    const discard = createBranchDiscard({
      store: createDrizzleBranchDiscard(db, {
        coordinator,
        close: draftClose,
        branches: workBranches,
        workProjection,
        treeLists,
      }),
      holdRetirement: draftClose.holdRetirement,
    });

    const commands = createDrizzleDocumentCommands(db);
    const service = createApplyClickService({
      commands,
      evidence: {} as never,
      store: apply,
    });
    const undoDiscard = createUndoDiscardService({
      commands,
      store: createDrizzleUndoDiscard(db, {
        workProjection,
        branches: workBranches,
        treeLists,
        reopen,
      }),
    });

    const viewOf = () => ({ draft: branchId as string });
    // The account's list sorts before the project's: a path that takes the project's key first
    // and the account's later is the one that can deadlock.
    let ACCOUNT_LIST = "";
    let PROJECT_LIST = "";

    beforeEach(async () => {
      ACCOUNT_LIST = `0${randomUUID().slice(1)}`;
      PROJECT_LIST = `f${randomUUID().slice(1)}`;
      await deleteDrizzleRows(db, [users]);
      await db
        .insert(users)
        .values({ ...conformanceUserValues(USER, "apply-discard"), treeListId: ACCOUNT_LIST });
      await db.insert(projects).values({
        id: PROJECT,
        treeListId: PROJECT_LIST,
        userId: USER,
        name: "Project",
        slug: "project",
      });
      await db.insert(contextSources).values({
        id: SOURCE,
        projectId: PROJECT,
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
        kind: "apply" as const,
        branchId,
        digest: commandId,
      };
    }

    async function click(documentId: DocumentId) {
      return applyNodes([documentId], randomUUID());
    }

    /** Apply of nodes, as one command; no text cut reaches the text half. */
    async function applyNodes(
      nodes: readonly string[],
      commandId: string,
      saw?: TreeCut,
      tree = true,
    ) {
      return apply.apply(
        {
          branchId,
          envelope: envelope(commandId),
          request: {
            commandId: commandId as CommandId,
            items: nodes.map((node) => ({ node, ...(tree ? { tree: true as const } : {}) })),
          },
        } as never,
        nodes.map((node) => ({ node, tree, text: null })),
        saw,
      );
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
      return rows.find((row) => row.branchId === branchId)?.documents ?? 0;
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

      const answer = await click(id);
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

      expect((await click(a)).status).toBe("applied");
      expect(await liveRow(a)).toMatchObject({ name: "alpha two" });

      expect((await click(b)).status).toBe("applied");
      expect(await liveRow(b)).toMatchObject({ parentId: folder });
      expect(await liveRow(folder)).toMatchObject({ kind: "folder", name: "Arc" });

      expect((await click(c)).status).toBe("applied");
      expect((await liveRow(c))?.trashRecord).not.toBeNull();
      expect(await branchRow(c)).toBeUndefined();
    });

    it("answers a second press `already`, and lands nothing twice", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "first"));
      expect((await click(a)).status).toBe("applied");
      const second = await click(a);
      expect(second).toMatchObject({
        status: "applied",
        applied: [],
        items: [
          {
            node: a,
            tree: { landed: false, settled: [{ rule: "already", state: "applied", item: a }] },
          },
        ],
      });
      expect(await liveRow(a)).toMatchObject({ name: "first" });
    });

    it("brings back a document live deleted, and says so", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "kept"));
      await submit((writer) => writer.delete(LIVE, "system", a));
      expect((await liveRow(a))?.trashRecord).not.toBeNull();

      const answer = await click(a);
      expect(answer).toMatchObject({
        status: "applied",
        items: [
          { node: a, tree: { landed: true, settled: [{ rule: "restored", documentId: a }] } },
        ],
      });
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
        command: asCommand(),
      });
      expect(result).toMatchObject({ closed: [made], settled: [] });
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
      const userSource = await accountUserSource(db, USER as never);
      const id = (await seed.document(userSource, "notes.md", {
        view: viewOf(),
        actor: AGENT,
      })) as DocumentId;
      expect(await branchRow(id)).toMatchObject({ existsOnlyInDraft: true });
      expect((await click(id)).status).toBe("applied");
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
        command: asCommand(),
      });
      expect(result).toMatchObject({ branchClosed: true });
      expect(await liveRow(a)).toMatchObject({ trashRecord: null });
      expect(await liveRow(made)).toBeUndefined();
      expect((await db.select().from(documents).where(eq(documents.id, made)))[0]).toBeDefined();
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      expect(branch?.status).toBe("closed");
    });

    it("Apply of a drafted delete and another Work's whole Discard take the lists in one order", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await db.insert(documentDrafts).values({
        id: randomUUID(),
        documentId: a,
        kind: "work_draft",
        branchId,
        state: Buffer.alloc(0),
        stateVector: Buffer.alloc(0),
      });
      await submit((writer) => writer.delete(viewOf(), AGENT, a));
      const otherWork = randomUUID();
      await db.insert(works).values({
        id: otherWork,
        projectId: PROJECT,
        createdByUserId: USER,
        name: "Other",
        handle: "w2",
      });
      const [other] = await db
        .insert(branches)
        .values({ projectId: PROJECT, originWorkId: otherWork, createdBy: USER })
        .returning({ id: branches.id });
      const otherBranch = (other as { id: BranchId }).id;

      // Apply holds its list and the document, and has written; the other Work's Discard takes
      // the account's list and waits on the project's.
      const {
        a: applied,
        b: discarded,
        bWaited,
      } = await interleave(
        db,
        () => click(a),
        "treeList.afterRows",
        () =>
          discard.discardItems({
            branchId: otherBranch,
            userId: USER,
            selection: { kind: "whole" },
            command: asCommand(),
          }),
      );
      expect(bWaited).toBe(true);
      expect(applied).toMatchObject({ ok: true, value: { status: "applied" } });
      expect(discarded).toMatchObject({ ok: true });
    });

    it("Apply writes the list's rows only under the document's key, which derivation takes first", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await submit((writer) => writer.rename(viewOf(), AGENT, a, "renamed"));
      // Derivation's certification (`certifyDocumentDerivation`): the document's key, then the
      // location row of the document.
      const certify = () =>
        runInDrizzleTransaction(db, async () => {
          const tx = currentDrizzleDb(db);
          await lockDocumentMutation(tx, a);
          await tx
            .select({ version: treeNodes.locationVersion })
            .from(treeNodes)
            .where(eq(treeNodes.id, a))
            .for("no key update");
        });
      const {
        a: applied,
        b: certified,
        bWaited,
      } = await interleave(db, () => click(a), "treeList.afterRows", certify);
      expect(bWaited).toBe(true);
      expect(applied).toMatchObject({ ok: true, value: { status: "applied" } });
      expect(certified).toMatchObject({ ok: true });
    });

    it("answers `already` for a Discard of an item the Work has nothing left on", async () => {
      const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
      await expect(
        discard.discardItems({
          branchId,
          userId: USER,
          selection: { kind: "items", items: [{ documentId: a, origin: "edited", ends: "tree" }] },
          command: asCommand(),
        }),
      ).resolves.toMatchObject({
        closed: [a],
        settled: [{ rule: "already", state: "discarded", item: a }],
      });
    });

    describe("commands over the tree half", () => {
      const envelopeOf = (kind: "apply" | "unapply" | "undo_discard", commandId: string) => ({
        commandId: commandId as CommandId,
        accountId: USER,
        projectId: PROJECT as never,
        kind,
        digest: commandId,
      });
      /** Apply of several nodes, as the group route sends it, at the revisions now on screen. */
      async function applyGroup(nodes: readonly string[], commandId: string = randomUUID()) {
        return service.apply({
          branchId,
          envelope: envelopeOf("apply", commandId),
          request: {
            commandId: commandId as CommandId,
            items: nodes.map((node) => ({ node, tree: true as const })),
          },
        });
      }
      const undo = (discardCommandId: string, commandId: string = randomUUID(), on = branchId) =>
        undoDiscard({
          branchId: on,
          userId: USER,
          envelope: envelopeOf("undo_discard", commandId),
          request: {
            commandId: commandId as CommandId,
            discardCommandId: discardCommandId as CommandId,
          },
        });
      /** A Work draft of the document holding `text`: what a closed draft keeps after a Discard. */
      async function draftOf(documentId: DocumentId, text: string) {
        const doc = new Y.Doc();
        doc.getText("body").insert(0, text);
        const id = `draft_${randomUUID()}`;
        await db.insert(documentDrafts).values({
          id,
          documentId,
          kind: "work_draft",
          branchId,
          state: Buffer.from(Y.encodeStateAsUpdate(doc)),
          stateVector: Buffer.from(Y.encodeStateVector(doc)),
          // Judged at its revision: it holds a change, as the effect projection would say.
          hasEffect: true,
          hasEffectRevision: 0,
        });
        return id;
      }
      const workRow = async () => {
        const [row] = await db.select().from(works).where(eq(works.id, WORK));
        return {
          pendingDocumentCount: row?.pendingDocumentCount,
          entityRevision: Number(row?.entityRevision),
        };
      };
      const draftsOn = (documentId: DocumentId, on: string, status: "active" | "closed") =>
        db
          .select()
          .from(documentDrafts)
          .where(
            and(
              eq(documentDrafts.documentId, documentId),
              eq(documentDrafts.branchId, on as BranchId),
              eq(documentDrafts.status, status),
            ),
          );
      async function unapply(applyCommandId: string, commandId: string = randomUUID()) {
        return service.unapply({
          branchId,
          envelope: envelopeOf("unapply", commandId),
          request: {
            commandId: commandId as CommandId,
            applyCommandId: applyCommandId as CommandId,
          },
        });
      }

      it("applies a drafted folder rename alone, and Un-Apply puts it back once", async () => {
        const folder = await seed.folder(SOURCE, "Arc");
        await submit((writer) => writer.rename(viewOf(), AGENT, folder, "Arc two"));
        expect(await branchRow(folder)).toMatchObject({ name: "Arc two" });

        const commandId = randomUUID();
        expect(await applyGroup([folder], commandId)).toMatchObject({ status: "applied" });
        expect(await liveRow(folder)).toMatchObject({ name: "Arc two" });
        expect(await branchRow(folder)).toBeUndefined();

        // A repeated id answers the stored outcome and writes nothing more.
        const before = await submit((writer) => listRecords(writer.doc).length);
        expect(await applyGroup([folder], commandId)).toMatchObject({ status: "applied" });
        expect(await submit((writer) => listRecords(writer.doc).length)).toBe(before);

        const undo = randomUUID();
        expect(await unapply(commandId, undo)).toMatchObject({ status: "unapplied" });
        expect(await liveRow(folder)).toMatchObject({ name: "Arc" });
        expect(await branchRow(folder)).toMatchObject({ name: "Arc two" });
        expect(await unapply(commandId, undo)).toMatchObject({ status: "unapplied" });
        // Taken back already: nothing of it is left to take back.
        expect(await unapply(commandId)).toMatchObject({
          status: "unapplied",
          settled: [{ rule: "already", state: "unapplied" }],
        });
      });

      it("applies a folder and what is under it as one command, and one Un-Apply takes both", async () => {
        const folder = await seed.folder(SOURCE, "Part", { view: viewOf(), actor: AGENT });
        const chapter = (await seed.document(SOURCE, "Part/one.md", {
          view: viewOf(),
          actor: AGENT,
        })) as DocumentId;
        const commandId = randomUUID();
        expect(await applyGroup([folder, chapter], commandId)).toMatchObject({
          status: "applied",
        });
        expect(await liveRow(folder)).toMatchObject({ kind: "folder", trashRecord: null });
        expect(await liveRow(chapter)).toMatchObject({ parentId: folder });
        expect(await pendingCount()).toBe(0);

        expect(await unapply(commandId)).toMatchObject({ status: "unapplied" });
        // Each fact is taken back by its opposite: the live copies go to Trash, and the Work's
        // records are pending again.
        expect(await liveRow(folder)).toMatchObject({ trashRecord: expect.any(String) });
        expect(await liveRow(chapter)).toMatchObject({ trashRecord: expect.any(String) });
        expect(await branchRow(chapter)).toMatchObject({ deleted: false });
        expect(await pendingCount()).toBe(1);
      });

      it("takes back an Apply's facts one by one, whatever else was admitted to the list since", async () => {
        const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
        await submit((writer) => writer.rename(viewOf(), AGENT, a, "renamed"));
        const commandId = randomUUID();
        expect(await applyGroup([a], commandId)).toMatchObject({ status: "applied" });
        await seed.document(SOURCE, "elsewhere.md");
        expect(await unapply(commandId)).toMatchObject({ status: "unapplied" });
        expect(await liveRow(a)).toMatchObject({ name: "alpha" });
      });

      it("Undo of a Discard brings its records back pending, once, for a part and a whole Discard", async () => {
        const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
        const made = (await seed.document(SOURCE, "made.md", {
          view: viewOf(),
          actor: AGENT,
        })) as DocumentId;
        await submit((writer) => writer.rename(viewOf(), AGENT, a, "renamed"));
        const part = asCommand();
        await discard.discardItems({
          branchId,
          userId: USER,
          selection: {
            kind: "items",
            items: [{ documentId: made, origin: "created", ends: "item" }],
          },
          command: part,
        });
        expect(await branchRow(made)).toBeUndefined();

        expect(await undo(part.envelope.commandId)).toMatchObject({
          status: "restored",
          branchId,
          restored: 1,
        });
        expect(await branchRow(made)).toMatchObject({ existsOnlyInDraft: true, deleted: false });
        expect(await branchRow(a)).toMatchObject({ name: "renamed" });
        expect(await undo(part.envelope.commandId)).toMatchObject({
          status: "restored",
          restored: 0,
          settled: [{ rule: "already", state: "restored" }],
        });

        // A whole Discard closes the branch; its Undo lands on the Work's new one.
        const whole = asCommand();
        await discard.discardItems({
          branchId,
          userId: USER,
          selection: { kind: "whole" },
          command: whole,
        });
        const restored = await undo(whole.envelope.commandId);
        expect(restored).toMatchObject({ status: "restored" });
        if (restored.status !== "restored") return;
        expect(restored.branchId).not.toBe(branchId);
        const rows = await db
          .select()
          .from(branchTreeNodes)
          .where(eq(branchTreeNodes.branchId, restored.branchId));
        expect(rows.map((row) => row.id).sort()).toEqual([a, made].sort());
      });

      // Guards: a Discard's Undo that restored the tree records and left the closed drafts'
      // text behind (a restored chapter applied empty; a text-only Discard answered
      // `superseded`).
      it("Restore reopens the closed draft as the same row, swaps a newer one in, and a late retirement leaves it alone", async () => {
        const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
        const kept = await draftOf(a, "the writer's paragraph");
        const part = asCommand();
        await discard.discardItems({
          branchId,
          userId: USER,
          selection: { kind: "items", items: [{ documentId: a, origin: "edited", ends: "item" }] },
          command: part,
        });
        expect(await draftsOn(a, branchId, "active")).toHaveLength(0);

        // The Work drafts the document again; the restore closes that draft under itself.
        const newer = await draftOf(a, "typed after the discard");
        // It counts as pending, as the effect projection would judge it.
        await db
          .update(documentDrafts)
          .set({ hasEffect: true })
          .where(eq(documentDrafts.id, newer));
        await workProjection.mutate({ works: [WORK as never] }, async () => undefined);
        const beforeSwap = await workRow();
        woken.length = 0;
        const first = await undo(part.envelope.commandId);
        expect(first).toMatchObject({ status: "restored", branchId, restored: 1, swapped: 1 });
        // One draft closed and one reopened: the count stays, the current draft changed.
        const afterSwap = await workRow();
        expect(afterSwap.pendingDocumentCount).toBe(beforeSwap.pendingDocumentCount);
        expect(afterSwap.entityRevision).toBe(beforeSwap.entityRevision + 1);
        expect(woken).toContain(`work:${WORK}`);
        const [reopened] = await draftsOn(a, branchId, "active");
        expect(reopened).toMatchObject({ id: kept, closedBy: null, closedCause: null });
        const [swappedOut] = await db
          .select()
          .from(documentDrafts)
          .where(eq(documentDrafts.id, newer));
        expect(swappedOut).toMatchObject({
          status: "closed",
          closedBy: (first as { commandId: string }).commandId,
        });

        // Nothing is left to take from the entry, and a retirement of the Discard that runs now
        // finds the draft reopened and closes no room.
        expect(await undo(part.envelope.commandId)).toMatchObject({
          status: "restored",
          restored: 0,
          settled: [{ rule: "already", state: "restored" }],
        });
        const closedRooms: string[] = [];
        await createDraftRetirement({
          closeDraftRoom: (draftId) => closedRooms.push(draftId),
          closeRemovedRooms: async () => {},
          stillClosedBy: (drafts) => draftsStillClosedBy(db, drafts),
        })({
          closed: [
            {
              draftId: kept,
              documentId: a,
              cause: "edit_discarded",
              by: part.envelope.commandId,
            },
            {
              draftId: newer,
              documentId: a,
              cause: "edit_discarded",
              by: (first as { commandId: string }).commandId,
            },
          ],
          removed: new Map(),
        });
        expect(closedRooms).toEqual([newer]);

        // Restoring the restore's own entry swaps the text back.
        const back = await undo((first as { commandId: string }).commandId);
        expect(back).toMatchObject({ status: "restored", restored: 1, swapped: 1 });
        expect((await draftsOn(a, branchId, "active")).map((row) => row.id)).toEqual([newer]);

        // A restore on an archived Work bounces: stored as done with nothing changed, and
        // replayed after the Work is unarchived.
        const bounced = {
          status: "restored",
          restored: 0,
          settled: [{ rule: "returned", why: "work_archived" }],
        };
        await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, WORK));
        const turnedAway = randomUUID();
        expect(await undo(part.envelope.commandId, turnedAway)).toMatchObject(bounced);
        await db.update(works).set({ archivedAt: null }).where(eq(works.id, WORK));
        expect(await undo((first as { commandId: string }).commandId, turnedAway)).toMatchObject(
          bounced,
        );

        // A whole Discard with a tree record and a text draft: both come back on the new branch.
        const b = (await seed.document(SOURCE, "beta.md")) as DocumentId;
        await submit((writer) => writer.rename(viewOf(), AGENT, b, "beta two"));
        const betaDraft = await draftOf(b, "beta text");
        const whole = asCommand();
        await discard.discardItems({
          branchId,
          userId: USER,
          selection: { kind: "whole" },
          command: whole,
        });
        const restored = await undo(whole.envelope.commandId);
        expect(restored).toMatchObject({ status: "restored", restored: 3 });
        if (restored.status !== "restored") return;
        expect(restored.branchId).not.toBe(branchId);
        expect((await draftsOn(a, restored.branchId, "active")).map((row) => row.id)).toEqual([
          newer,
        ]);
        expect((await draftsOn(b, restored.branchId, "active")).map((row) => row.id)).toEqual([
          betaDraft,
        ]);
        expect(
          (
            await db
              .select()
              .from(branchTreeNodes)
              .where(eq(branchTreeNodes.branchId, restored.branchId))
          ).length,
        ).toBeGreaterThan(0);
      });

      // Guards: Un-Apply left the restore that "Restore and apply" made in live, because the
      // restore was not among the Apply's recorded copies.
      it("Un-Apply of a 'restore and apply' puts the restored document back in Trash", async () => {
        const a = (await seed.document(SOURCE, "alpha.md")) as DocumentId;
        await submit((writer) => writer.rename(viewOf(), AGENT, a, "kept"));
        await submit((writer) => writer.delete(LIVE, "system", a));
        const commandId = randomUUID();
        expect(await applyNodes([a], commandId)).toMatchObject({
          status: "applied",
          items: [
            { node: a, tree: { landed: true, settled: [{ rule: "restored", documentId: a }] } },
          ],
        });
        expect(await liveRow(a)).toMatchObject({ name: "kept", trashRecord: null });

        expect(await unapply(commandId)).toMatchObject({ status: "unapplied" });
        // The restore left with the copies: the document is in Trash again, its rename pending.
        expect((await liveRow(a))?.trashRecord).not.toBeNull();
        expect(await branchRow(a)).toMatchObject({ name: "kept" });
      });
    });
  },
);
