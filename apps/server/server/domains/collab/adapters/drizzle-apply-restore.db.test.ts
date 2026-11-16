/**
 * Undo an Apply, then restore the Discard: the draft the writer gets back is the one they had, and
 * the text they un-applied is pending once. Text lost here is the worst bug the product can have,
 * so this runs the real Apply, Discard, Un-Apply and Restore commands over Postgres and asserts on
 * the text the writer sees (live text, the draft's base and text, the pending count), never on rows.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Un-Apply of an Apply whose draft a Discard closed still takes the text out of the base
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  baseViewDelta,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { BranchId, CommandId, DocumentId, UserId } from "@meridian/contracts";
import type { ApplyClick } from "@meridian/contracts/branches";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  contextSources,
  documentDrafts,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  handleApplyClickRequest,
  handleApplyItemsRequest,
  handleUnapplyClickRequest,
} from "../../../lib/branch-review-route.js";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createTreeReader } from "../../context/tree/tree-view.js";
import {
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
} from "../../file-policy/index.js";
import { createApplyClickService } from "../domain/apply-click.js";
import { createBranchDiscard } from "../domain/branch-discard.js";
import { createBranchReviewIdentity } from "../domain/branch-review-identity.js";
import { createBranchReviewItems } from "../domain/branch-review-items.js";
import { createBranches } from "../domain/branches.js";
import { createDraftCoordinator } from "../domain/draft-coordinator.js";
import { materializeDraftRead } from "../domain/draft-store.js";
import { createUndoDiscardService } from "../domain/undo-discard.js";
import { createDrizzleApplyClick } from "./drizzle-apply-click.js";
import { createDrizzleBranchDiscard } from "./drizzle-branch-discard.js";
import { createDrizzleBranchTreeActors } from "./drizzle-branch-tree-actors.js";
import { createDrizzleBranchTreeState } from "./drizzle-branch-tree-state.js";
import { createDrizzleBranchStore, createDrizzleBranchWriteBoundary } from "./drizzle-branches.js";
import { createDrizzleCommandDocuments } from "./drizzle-command-documents.js";
import { createDrizzleDocumentCommands } from "./drizzle-document-commands.js";
import { createDrizzleDraftDispositionStore } from "./drizzle-draft-disposition.js";
import { createDrizzleDraftStore } from "./drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";
import { createReopenDrafts } from "./drizzle-reopen-drafts.js";
import { createDrizzleUndoDiscard } from "./drizzle-undo-discard.js";
import { createDrizzleWorkBranchPendingStore } from "./drizzle-work-branch-pending.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const pm = buildDocumentSchema();
const paragraph = (text: string) => pm.nodes.paragraph.create({ id: "p0" }, pm.text(text));
const blocks = (texts: string[]) => texts.map(paragraph);

describe.skipIf(!enabled || !process.env.DATABASE_URL)(
  "Un-Apply, then restore a Discard (postgres)",
  () => {
    const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
    afterAll(() => db.close());

    const USER = randomUUID() as UserId;
    const PROJECT = randomUUID();
    const SOURCE = randomUUID();
    const WORK = randomUUID();
    let seeded = 0;

    const projection = createTestWorkProjectionMutation(db);
    const { draftClose, treeLists } = createTestRemovalDeps(db);
    const branchStore = createDrizzleBranchStore(db);
    const workBranches = createBranches({
      store: branchStore,
      boundary: createDrizzleBranchWriteBoundary(db, projection),
    });
    const persistence = createDrizzleCollabPersistence(db);
    const draftStore = createDrizzleDraftStore(db, {
      close: draftClose,
      treeLists,
      workProjection: projection,
      branches: branchStore,
      live: persistence,
      onAppendSequenced: () => {},
    });
    const coordinator = createDraftCoordinator({
      onAppendCommitted: () => {},
      store: draftStore,
      attemptScope: (operation) => operation(),
    });
    const treeReader = createTreeReader(db);
    const branchTree = createDrizzleBranchTreeState(db, treeReader);
    const commands = createDrizzleDocumentCommands(db);
    const pending = createDrizzleWorkBranchPendingStore(db);
    const reopen = createReopenDrafts(db, {
      coordinator,
      close: draftClose,
      treeLists,
      workProjection: projection,
      live: persistence.journal,
      scheduleLivePull: () => {},
    });
    const applyService = createApplyClickService({
      commands,
      evidence: createDrizzleDraftDispositionStore(db),
      store: createDrizzleApplyClick(db, {
        workProjection: projection,
        branches: workBranches,
        coordinator,
        reopen,
        live: persistence.journal,
        liveCoordinator: { deliver: async () => {} },
        arrivals: { settle: async () => 0 },
        treeLists,
        tree: treeReader,
        close: draftClose,
        onCommitted: async () => {},
        merged: () => {},
        measured: () => {},
        answeredWithoutLanding: () => {},
      }),
    });
    const discardKernel = createBranchDiscard({
      store: createDrizzleBranchDiscard(db, {
        coordinator: coordinator,
        close: draftClose,
        branches: workBranches,
        workProjection: projection,
        treeLists,
      }),
      holdRetirement: draftClose.holdRetirement,
    });
    const undoDiscard = createUndoDiscardService({
      commands,
      store: createDrizzleUndoDiscard(db, {
        workProjection: projection,
        branches: workBranches,
        treeLists,
        reopen,
      }),
    });
    const identity = createBranchReviewIdentity({
      branches: branchStore,
      reviewItems: createBranchReviewItems({
        tree: branchTree,
        drafts: pending.listBranchDraftMetadata,
        pendingThreadIds: pending.pendingThreadIds,
        treeActors: createDrizzleBranchTreeActors(db, treeLists),
      }),
    });
    const routeServices = {
      projects: {
        findById: async (id: string) =>
          (await db.select().from(projects).where(eq(projects.id, id)))[0],
      },
      works: {
        findById: async (id: string) => (await db.select().from(works).where(eq(works.id, id)))[0],
      },
      fileAccess: createFileAccess({
        facts: createDrizzleFileFacts(db, projection),
        grants: createOwnerFileGrants(),
        readAgentChain: async () => [],
      }),
      documentSync: {
        draftReview: {
          apply: applyService.apply,
          unapplyClick: applyService.unapply,
          commandDocuments: createDrizzleCommandDocuments(db, { treeLists }),
          resolveItemByDocument: identity.resolveReviewItemByDocument,
          resolveItemInBranch: identity.resolveReviewItemInBranch,
          branchOwner: (branchId: BranchId) => branchStore.ownerOf(branchId),
          lookupCommand: commands.lookup,
          awaitCommand: commands.await,
        },
        roomRemoval: async () => null,
      },
    } as never;

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.insert(users).values(conformanceUserValues(USER, "apply-restore"));
      await db.insert(projects).values({
        id: PROJECT,
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
    });

    const liveDoc = async (documentId: string) => {
      const read = await persistence.journal.read(documentId);
      const doc = new Y.Doc({ gc: false });
      if (read.checkpoint) Y.applyUpdate(doc, read.checkpoint);
      for (const row of read.updates) Y.applyUpdate(doc, row.update);
      return doc;
    };
    const textOf = (doc: Y.Doc, fragment: string) =>
      readBlocks(doc.getXmlFragment(fragment), pm).map((b) => b.textContent);

    /** A Work whose branch holds a draft of a live document: the writer's edit waiting for review. */
    async function fixture(baseText: string, draftText: string) {
      const [branch] = await db
        .insert(branches)
        .values({ projectId: PROJECT, originWorkId: WORK, createdBy: USER })
        .returning({ id: branches.id });
      const branchId = (branch as { id: BranchId }).id;
      const documentId = randomUUID() as DocumentId;
      await treeSeeder(db).document(SOURCE, `restore-${randomUUID()}.md`, { id: documentId });
      const seed = new Y.Doc({ gc: false });
      writeBlocks(seed.getXmlFragment("prosemirror"), pm, blocks([baseText]));
      await persistence.seeds.seedInitialDocument(documentId, Y.encodeStateAsUpdate(seed));
      const liveSeed = await liveDoc(documentId);
      const snapshot = await draftStore.ensureDocumentDraft({
        documentId,
        branchId,
        liveDoc: liveSeed,
        liveRoom: null,
      });
      const room = await coordinator.readDraft(snapshot.draftId, async (doc) => {
        const copy = new Y.Doc({ gc: false });
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
        seeded += 1;
        copy.clientID = 1000 + seeded;
        return copy;
      });
      const f = {
        branchId,
        documentId,
        draftId: snapshot.draftId,
        /** The writer types `text` into the draft. */
        async type(text: string) {
          let update: Uint8Array | undefined;
          room.on("update", (bytes: Uint8Array) => {
            update = bytes;
          });
          room.transact(() => writeBlocks(room.getXmlFragment("prosemirror"), pm, blocks([text])));
          const write = coordinator.prepareAppend(await coordinator.loadBase(snapshot.draftId), [
            {
              draftId: snapshot.draftId,
              source: "writer",
              updateData: update as Uint8Array,
              actorUserId: USER,
            },
          ]);
          try {
            await write.persist();
            write.transfer();
          } finally {
            write.dispose();
          }
        },
        /** Pull the durable draft into the writer's room, as a reconnecting tab would. */
        async sync() {
          const read = await draftStore.readDraftAt(snapshot.draftId);
          assert.ok(read);
          Y.applyUpdate(room, Y.encodeStateAsUpdate(materializeDraftRead(read)));
        },
        /** The click that applies every pending group of the draft as the tab shows it. */
        click(): ApplyClick {
          const base = readBlocks(room.getXmlFragment(REVIEW_BASE_FRAGMENT), pm);
          const projectionOfDraft = projectReview(
            diffBlocks(base, readBlocks(room.getXmlFragment("prosemirror"), pm)),
          );
          return {
            commandId: randomUUID(),
            draftId: snapshot.draftId,
            snapshot: Buffer.from(Y.encodeSnapshotV2(Y.snapshot(room))).toString("base64"),
            baseViewDelta: baseViewDelta(pm, base, base).map((patch) => ({
              ...patch,
              blocks: patch.blocks.map((block) => block.toJSON()),
            })),
            groupIds: projectionOfDraft.groups.map((group) => group.id),
          } as ApplyClick;
        },
        apply: (click: ApplyClick) =>
          handleApplyClickRequest(routeServices, {
            userId: USER,
            projectId: PROJECT,
            branchId,
            documentId,
            request: click,
          }),
        unapply: (click: ApplyClick) =>
          handleUnapplyClickRequest(routeServices, {
            userId: USER,
            projectId: PROJECT,
            branchId,
            request: { commandId: randomUUID(), applyCommandId: click.commandId },
          }),
        /** What the writer sees: the live text, the draft's base and text, and what is pending. */
        async seen() {
          const read = await draftStore.readDraftAt(snapshot.draftId);
          assert.ok(read);
          const draft = materializeDraftRead(read);
          const live = await liveDoc(documentId);
          const base = textOf(draft, REVIEW_BASE_FRAGMENT);
          const text = textOf(draft, "prosemirror");
          const out = {
            live: textOf(live, "prosemirror"),
            base,
            draft: text,
            pending: projectReview(
              diffBlocks(
                readBlocks(draft.getXmlFragment(REVIEW_BASE_FRAGMENT), pm),
                readBlocks(draft.getXmlFragment("prosemirror"), pm),
              ),
            ).groups.length,
          };
          draft.destroy();
          live.destroy();
          return out;
        },
      };
      if (draftText !== baseText) await f.type(draftText);
      return f;
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;

    /** A1 puts "big" in the draft, A2 puts "black" beside it; both applied. */
    async function twoApplies() {
      const f = await fixture("The cat sat.", "The big cat sat.");
      const a1 = f.click();
      expect((await f.apply(a1)).status).toBe("applied");
      await f.sync();
      await f.type("The big black cat sat.");
      const a2 = f.click();
      expect((await f.apply(a2)).status).toBe("applied");
      return { f, a1, a2 };
    }

    async function discard(f: Fixture) {
      const commandId = randomUUID();
      // A Restore of Discard all reopens the draft on the Work's new branch.
      const [{ branchId }] = await db
        .select({ branchId: documentDrafts.branchId })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, f.draftId));
      const out = await discardKernel.discardItems({
        branchId,
        userId: USER,
        // Whole: an item Discard takes nothing from a draft its Applies emptied (it answers
        // `overtaken applied`), and Discard all closes every draft of the branch.
        selection: { kind: "whole" },
        command: {
          envelope: envelope("discard", commandId),
          result: () => ({ status: "discarded", branchId }) as never,
        },
      });
      expect(out).toMatchObject({ branchClosed: true, settled: [] });
      return { commandId, branchId };
    }
    const envelope = (kind: string, commandId: string) =>
      ({ commandId, accountId: USER, projectId: PROJECT, kind, digest: commandId }) as never;
    /** Restore as Trash sends it: the branch the Discard ran on, not the draft's current one. */
    async function restore(discarded: Awaited<ReturnType<typeof discard>>) {
      const commandId = randomUUID();
      const out = (await undoDiscard({
        branchId: discarded.branchId,
        userId: USER,
        envelope: envelope("undo_discard", commandId),
        request: { commandId: commandId as CommandId, discardCommandId: discarded.commandId },
      } as never)) as { status: string; restored: number };
      expect(out).toMatchObject({ status: "restored" });
      expect(out.restored).toBeGreaterThan(0);
    }

    it("A1, A2 inside A1's text, Discard, Un-Apply both, Restore: the draft is what it is without the Discard", async () => {
      const without = await twoApplies();
      await without.f.unapply(without.a2);
      await without.f.unapply(without.a1);
      const wanted = await without.f.seen();

      const withDiscard = await twoApplies();
      const discarded = await discard(withDiscard.f);
      await withDiscard.f.unapply(withDiscard.a2);
      await withDiscard.f.unapply(withDiscard.a1);
      await restore(discarded);
      const got = await withDiscard.f.seen();

      expect(got).toEqual(wanted);
      expect(got.pending).toBe(1);
      expect(got.base).toEqual(["The cat sat."]);
      expect(got.draft).toEqual(["The big black cat sat."]);
    });

    it("Apply, Discard, Un-Apply, Restore, Discard, Restore: the text is pending once", async () => {
      const f = await fixture("The cat sat.", "The big cat sat.");
      const a1 = f.click();
      await f.apply(a1);
      const discarded = await discard(f);
      await f.unapply(a1);
      await restore(discarded);
      const first = await f.seen();
      const again = await discard(f);
      await restore(again);
      expect(await f.seen()).toEqual(first);
      expect(first.pending).toBe(1);
      expect(first.base).toEqual(["The cat sat."]);
    });

    it("Un-Apply, Apply the same text again, Discard, Restore: the second Apply's text stays in the base", async () => {
      const f = await fixture("The cat sat.", "The big cat sat.");
      const a1 = f.click();
      await f.apply(a1);
      await f.unapply(a1);
      await f.sync();
      await f.apply(f.click());
      const before = await f.seen();
      expect(before.base).toEqual(["The big cat sat."]);
      await restore(await discard(f));
      expect(await f.seen()).toEqual(before);
    });

    it("text Apply, then a drafted delete's Apply; Un-Apply the text, then the delete: the text is pending once", async () => {
      const f = await fixture("The cat sat.", "The big cat sat.");
      const textApply = f.click();
      await f.apply(textApply);
      await treeLists.submit({
        lists: [await treeListOfSource(db, SOURCE)],
        make: ([{ writer }]) => writer.delete({ draft: f.branchId }, `user:${USER}`, f.documentId),
      });
      const deleteApply = randomUUID();
      const answer = await handleApplyItemsRequest(routeServices, {
        userId: USER,
        projectId: PROJECT,
        branchId: f.branchId,
        request: { commandId: deleteApply, items: [{ node: f.documentId, tree: true }] },
      } as never);
      expect(answer.status).toBe("applied");
      await f.unapply(textApply);
      await f.unapply({ commandId: deleteApply } as ApplyClick);
      const seen = await f.seen();
      expect(seen.base).toEqual(["The cat sat."]);
      expect(seen.pending).toBe(1);
    });
  },
);
