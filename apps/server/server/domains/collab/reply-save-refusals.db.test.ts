/** Consolidated test contracts; each block retains its original fixture scope. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkId } from "@meridian/contracts/runtime";
import { and, eq } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "./adapters/drizzle-drafts.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";
import { createDrafts } from "./domain/drafts.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  SOURCE_ID,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { seedSecondWork, THREAD_B_ID, WORK_B_ID } from "./test-support/cross-work-probe-harness.js";
import {
  createResponse,
  responseContext,
  stageDraft,
} from "./test-support/document-edit-receipt-fixture.js";
import { commitBranchEdit, reviewDriver } from "./test-support/draft-review-requests.js";

__mergedSuite("reply-save-refusals.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/reply-save-refusals.db.test.ts.
  const DRAFT = "Write did not land: the user discarded this draft. Re-read and retry.";

  const EDIT = "Write did not land: the user discarded the text it edited. Re-read and retry.";

  const DOC = "Write did not land: the user discarded this new document. Re-read and retry.";

  type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;

  type Saved = Awaited<ReturnType<ReturnType<typeof createHarness>["commit"]>>;

  /** Each refused write's document and the copy its receipt carries, in save order. */
  function refused(saved: Saved) {
    return saved.documents.flatMap((doc) =>
      doc.receipts.flatMap((receipt) =>
        receipt.result.status === "invalid_write" ? [[doc.documentId, receipt.result.message]] : [],
      ),
    );
  }

  __mergedSuite("reply save refusals (postgres)", () => {
    const db = createTestDatabase();
    let harness: ReturnType<typeof createHarness>;
    beforeEach(async () => {
      await resetDatabase(db);
      harness = createHarness(db);
    });
    afterEach(() => {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    });
    afterAll(() => closeDatabase(db));
    /** Alpha holds two persisted AI changes; a second reply then stages its own writes. */
    async function setup() {
      const staged = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
        ["red", "gold"],
        ["blue", "azure"],
      ]);
      const { fixture } = staged;
      const responseId = await createResponse(db, 2);
      const context = responseContext(responseId);
      const core = fixture.collab.agentEdit();
      const review = reviewDriver(fixture.collab.draftReview);
      const write = (find: string, content: string, id: string) =>
        core.write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find,
            content,
            tool_use_id: id,
          },
          context,
        );
      return { ...staged, responseId, context, core, review, write };
    }
    it("1: independent staged writes survive a per-change Discard and land at generation +1", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(await write("gold", "silver", "w-gold")).toMatchObject({ phase: "staged" });
      const preview = await review.activePreview(ALPHA_ID);
      const azure = preview.operations.find((op) => op.afterExcerpt === "azure");
      expect(
        await review.discardChanges(ALPHA_ID, preview, [azure?.operationId as string]),
      ).toMatchObject({
        status: "discarded",
      });
      const saved = await harness.commit(responseId);
      expect(saved).toMatchObject({
        status: "committed",
        documents: [{ updateCount: 2 }],
      });
      expect(await fixture.draftMarkdown(branchId)).toBe("silver\n\nblue\n\nlime\n");
      expect(await harness.branchGeneration(branchId)).toBe(2);
    });
    it("3: Discard all while staged refuses the save with one receipt per write and nothing live", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(await write("gold", "silver", "w-gold")).toMatchObject({ phase: "staged" });
      expect(await review.discardAll()).toMatchObject({ status: "discarded" });
      const saved = await harness.commit(responseId);
      expect(refused(saved)).toEqual([
        [ALPHA_ID, DRAFT],
        [ALPHA_ID, DRAFT],
      ]);
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n\ngreen\n");
      expect(await review.list()).toEqual([]);
      expect(await fixture.draftMarkdown(branchId)).toContain("gold");
    });
    it("2: after two reforks and a prepared read, only edits on discarded text fail", async () => {
      const { fixture, branchId, responseId, review, write, core, context } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(await write("azure", "cyan", "w-azure")).toMatchObject({ phase: "staged" });
      const first = await review.activePreview(ALPHA_ID);
      const azure = first.operations.find((op) => op.afterExcerpt === "azure");
      await review.discardChanges(ALPHA_ID, first, [azure?.operationId as string]);
      expect(
        await core.read({ file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-2" }, context),
      ).toMatchObject({ status: "success" });
      const second = await review.activePreview(ALPHA_ID);
      await review.discardChanges(ALPHA_ID, second);
      const saved = await harness.commit(responseId);
      expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\nlime\n");
    });
    it("4: a mixed reply saves its other document and receipts the refused one", async () => {
      const { fixture, branchId, responseId, review, write, core, context } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(
        await core.write(
          {
            command: "create",
            file: "beta.md",
            documentId: BETA_ID,
            content: "Beta staged.",
            overwrite: true,
            tool_use_id: "w-beta",
          },
          { ...context, createdDocument: false },
        ),
      ).toMatchObject({ phase: "staged" });
      expect(await review.discardItem(ALPHA_ID)).toMatchObject({
        status: "discarded",
      });
      const saved = await harness.commit(responseId);
      expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
      expect(saved.documents.map((doc) => doc.documentId).sort()).toEqual(
        [ALPHA_ID, BETA_ID].sort(),
      );
      const beta = await fixture.branchStore.resolveWorkDraftBranchForThread(BETA_ID, THREAD_ID);
      beta.doc.destroy();
      expect(await fixture.draftMarkdown(beta.branchId)).toBe("Beta staged.\n");
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
    });
    it("5: a write after Discard all in the same reply lands in a fresh draft beside the first refusal", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(await review.discardAll()).toMatchObject({ status: "discarded" });
      const later = await write("blue", "navy", "w-blue");
      expect(later).toMatchObject({ phase: "staged" });
      const saved = await harness.commit(responseId);
      expect(refused(saved)).toEqual([[ALPHA_ID, DRAFT]]);
      expect(saved.documents[0]?.receipts).toHaveLength(2);
      const fresh = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
      fresh.doc.destroy();
      expect(fresh.branchId).not.toBe(branchId);
      expect(await fixture.draftMarkdown(fresh.branchId)).toBe("red\n\nnavy\n\ngreen\n");
    });
    const draftsOf = () =>
      createDrafts({
        store: createDrizzleDraftStore(db),
        boundary: createDrizzleDraftWriteBoundary(db),
      });
    /** Marks `documentId` as created by `workId`'s active draft, making that draft if need be. */
    async function claimCreate(documentId: string, workId: WorkId, threadId: string) {
      const draft = await draftsOf().ensureActiveForWrite({
        workId,
        projectId: PROJECT_ID as never,
        threadId: threadId as never,
        userId: USER_ID as never,
      });
      await db.insert(schema.draftTreeChanges).values({
        draftId: draft.id,
        nodeKind: "document",
        nodeId: documentId as never,
        created: true,
      });
    }
    /** A document the draft created and has not revealed: hidden, with its tree row. */
    async function hiddenCreate(documentId: string, name: string) {
      await db.insert(schema.documents).values({
        id: documentId as never,
        contextSourceId: SOURCE_ID,
        name,
        extension: "",
        hidden: true,
      });
      await claimCreate(documentId, WORK_ID, THREAD_ID);
    }
    /** Work B's draft claims the same hidden create, as two chats creating one path would. */
    async function shareHiddenCreate(fixture: Fixture) {
      await seedSecondWork(fixture);
      await claimCreate(NEW_ID, WORK_B_ID, THREAD_B_ID);
    }
    const NEW_ID = "00000000-0000-4000-8000-000000000830";
    const grantFor = (documentId: string, workId = WORK_ID, slug = "atomicity-work") => {
      const granted = testFileGrant({ kind: "draft", workId, workSlug: slug }, documentId);
      return {
        ...granted,
        principal: { ...granted.principal, accountId: USER_ID as never },
        facts: { ...granted.facts, projectId: PROJECT_ID as never },
      };
    };
    /** A reply that created `NEW_ID` in the draft and saved, then a second reply staging an edit on it. */
    async function createdThenStaged() {
      const base = await setup();
      const { core } = base;
      await hiddenCreate(NEW_ID, "created");
      const first = await createResponse(db, 3);
      expect(
        await core.write(
          { command: "create", file: "created", documentId: NEW_ID as never, content: "New." },
          { ...responseContext(first), grant: grantFor(NEW_ID), createdDocument: true },
        ),
      ).toMatchObject({ phase: "staged" });
      expect(await harness.commit(first)).toMatchObject({ status: "committed" });
      const second = await createResponse(db, 4);
      const context = { ...responseContext(second), grant: grantFor(NEW_ID) };
      expect(
        await core.write(
          {
            command: "replace",
            file: "created",
            documentId: NEW_ID as never,
            find: "New.",
            content: "Newer.",
            tool_use_id: "w-new",
          },
          context,
        ),
      ).toMatchObject({ phase: "staged" });
      return { ...base, second };
    }
    it("13: Discard of a created item while staged refuses discarded_document and leaves its tombstone", async () => {
      const { second, review } = await createdThenStaged();
      expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
      const saved = await harness.commit(second);
      expect(refused(saved)).toEqual([[NEW_ID, DOC]]);
      const [row] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, NEW_ID as never));
      expect(row?.deletedAt).not.toBeNull();
    });
    it("15b: another Work revealing the create while Discard waits for its leases keeps the branch and refuses discarded_edit", async () => {
      const { second, review, fixture } = await createdThenStaged();
      const remove = setCollabHook("discard.afterLeases", async () => {
        remove();
        await db
          .update(schema.documents)
          .set({ hidden: false })
          .where(eq(schema.documents.id, NEW_ID as never));
      });
      expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
      expect(refused(await harness.commit(second))).toEqual([[NEW_ID, EDIT]]);
      // The draft's own branch, by kind: the closed thread peer shares the document, and an
      // unordered select returns whichever row Postgres happens to place first.
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, NEW_ID as never),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      expect(branch?.status).toBe("active");
      // Reset from live, not closed: the branch holds exactly what the revealed document does.
      expect(await fixture.draftMarkdown(branch?.id as string)).toBe(
        await harness.liveMarkdown(NEW_ID),
      );
    });
    it("11: Apply all while staged drains the draft, which stays active, and the write lands in it even once the chat writes direct", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(await review.applyAll()).toMatchObject({ status: "completed" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nazure\n\ngreen\n");
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.threads.id, THREAD_ID as never));
      expect(refused(await harness.commit(responseId))).toEqual([]);
      expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\nlime\n");
      expect((await fixture.collab.draftReview.items({ workId: WORK_ID })).draftId).not.toBeNull();
    });
    it("11b: item Discard of a drained item still drops the staged write of a reply opened after Apply", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await review.applyAll()).toMatchObject({ status: "completed" });
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      expect(await review.discardItem(ALPHA_ID)).toMatchObject({
        status: "discarded",
      });
      expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, EDIT]]);
      expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\ngreen\n");
    });
    it("16: a per-change Discard racing a peer pull never shows its text on the next read", async () => {
      const { fixture, review, core } = await setup();
      const peer = await fixture.branchStore.resolveThreadBranch(ALPHA_ID, THREAD_ID);
      peer.doc.destroy();
      const preview = await review.activePreview(ALPHA_ID);
      const azure = preview.operations.find((op) => op.afterExcerpt === "azure");
      // The pause sits after the pull captured its upstream and before it persists the peer:
      // the Discard starts there and must wait for the pull's lease on that upstream.
      const pull = fixture.branchCoordinator.pullFromDoc;
      // Created here, outside the pull's lease scope, so the Discard waits for the lease
      // instead of tripping the re-entry guard.
      let startDiscard!: () => void;
      let settled = false;
      const discard = new Promise<void>((resolve) => {
        startDiscard = resolve;
      })
        .then(() => review.discardChanges(ALPHA_ID, preview, [azure?.operationId as string]))
        .finally(() => {
          settled = true;
        });
      let discardSettledAtApply: boolean | undefined;
      fixture.branchCoordinator.pullFromDoc = (async (...args: unknown[]) => {
        if (discardSettledAtApply === undefined && args.includes(peer.branchId)) {
          startDiscard();
          await new Promise((resolve) => setTimeout(resolve, 300));
          discardSettledAtApply = settled;
        }
        return (pull as (...pullArgs: unknown[]) => Promise<Uint8Array>).apply(
          fixture.branchCoordinator,
          args,
        );
      }) as typeof pull;
      try {
        await core.read(
          { file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-16" },
          responseContext(await createResponse(db, 3)),
        );
      } finally {
        fixture.branchCoordinator.pullFromDoc = pull;
      }
      expect(discardSettledAtApply).toBe(false);
      await discard;
      const next = await core.read(
        { file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-16-next" },
        responseContext(await createResponse(db, 4)),
      );
      expect(JSON.stringify(next.result)).not.toContain("azure");
    });
    __mergedSuite(
      "17: a save between a Discard's commit and its retirement is refused by branch state",
      () => {
        it("an edited document refuses discarded_edit", async () => {
          const { responseId, review, write } = await setup();
          expect(await write("green", "lime", "w-green")).toMatchObject({
            phase: "staged",
          });
          let saved: Saved | undefined;
          const remove = setCollabHook("discard.beforeRetirement", async () => {
            remove();
            saved = await harness.commit(responseId);
          });
          expect(await review.discardItem(ALPHA_ID)).toMatchObject({
            status: "discarded",
          });
          expect(refused(saved as Saved)).toEqual([[ALPHA_ID, EDIT]]);
        });
        it.each([
          {
            name: "a hidden create another Work's draft uses",
            reveal: false,
            other: true,
            copy: DOC,
          },
          { name: "a hidden create no other draft uses", reveal: false, other: false, copy: DOC },
        ])("$name refuses its branch state's copy", async ({ reveal, other, copy }) => {
          const { second, review, fixture } = await createdThenStaged();
          if (reveal) {
            await db
              .update(schema.documents)
              .set({ hidden: false })
              .where(eq(schema.documents.id, NEW_ID as never));
            await db
              .delete(schema.draftTreeChanges)
              .where(eq(schema.draftTreeChanges.nodeId, NEW_ID as never));
          }
          if (other) {
            await seedSecondWork(fixture);
            await shareHiddenCreate(fixture);
          }
          let saved: Saved | undefined;
          const remove = setCollabHook("discard.beforeRetirement", async () => {
            remove();
            saved = await harness.commit(second);
          });
          expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
          expect(refused(saved as Saved)).toEqual([[NEW_ID, copy]]);
        });
      },
    );
    it("22: a write landing between Discard all's commit and its retirement gets the named refusal, not an internal error", async () => {
      const { responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-old")).toMatchObject({ phase: "staged" });
      let late: Awaited<ReturnType<typeof write>> | undefined;
      const remove = setCollabHook("discard.beforeRetirement", async () => {
        remove();
        late = await write("blue", "navy", "w-late");
      });
      expect(await review.discardAll()).toMatchObject({ status: "discarded" });
      expect(late).toMatchObject({ isError: true, status: "invalid_write" });
      expect(JSON.stringify(late?.result)).toContain(DRAFT);
      expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, DRAFT]]);
    });
    it("23: an item Discard retiring the peer between a write's capture and its pull is named, not an internal error", async () => {
      const { responseId, review, write, fixture } = await setup();
      expect(await write("green", "lime", "w-old")).toMatchObject({ phase: "staged" });
      const withLeases = fixture.branchCoordinator.withLeases;
      let once = true;
      fixture.branchCoordinator.withLeases = (async (...args: Parameters<typeof withLeases>) => {
        if (once && args[0].length === 2) {
          once = false;
          await review.discardItem(ALPHA_ID);
        }
        return withLeases.apply(fixture.branchCoordinator, args);
      }) as typeof withLeases;
      let late: Awaited<ReturnType<typeof write>>;
      try {
        late = await write("blue", "navy", "w-late");
      } finally {
        fixture.branchCoordinator.withLeases = withLeases;
      }
      expect(late).toMatchObject({ isError: true, status: "invalid_write" });
      expect(JSON.stringify(late.result)).toContain(EDIT);
      expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, EDIT]]);
    });
    // The last-use Discard lands at each phase boundary of the peer pull, not only before its leases.
    const pullPhases = [
      "after the first ensure",
      "before the second ensure",
      "before the leases",
    ] as const;
    it.each(
      pullPhases.flatMap((phase) => [
        { phase, other: false, name: "last use deletes the branch rows" },
        ...(phase === "before the leases"
          ? [
              {
                phase,
                other: true,
                name: "another Work's draft still uses the create, so its rows close",
              },
            ]
          : []),
      ]),
    )("23b: Discard of a hidden create $phase of a write's pull names the document ($name)", async ({
      phase,
      other,
    }) => {
      const { second, review, fixture, core } = await createdThenStaged();
      if (other) {
        await seedSecondWork(fixture);
        await shareHiddenCreate(fixture);
      }
      const withLeases = fixture.branchCoordinator.withLeases;
      const ensure = fixture.branchStore.ensureThreadPeerBranch;
      let once = true;
      let ensures = 0;
      const discardOnce = async () => {
        if (!once) return;
        once = false;
        await review.discardItem(NEW_ID);
      };
      fixture.branchStore.ensureThreadPeerBranch = (async (...args: Parameters<typeof ensure>) => {
        ensures += 1;
        if (phase === "before the second ensure" && ensures === 2) await discardOnce();
        const peer = await ensure.apply(fixture.branchStore, args);
        if (phase === "after the first ensure" && ensures === 1) await discardOnce();
        return peer;
      }) as typeof ensure;
      fixture.branchCoordinator.withLeases = (async (...args: Parameters<typeof withLeases>) => {
        if (phase === "before the leases" && args[0].length === 2) await discardOnce();
        return withLeases.apply(fixture.branchCoordinator, args);
      }) as typeof withLeases;
      let late: Awaited<ReturnType<typeof core.write>>;
      try {
        late = await core.write(
          {
            command: "replace",
            file: "created",
            documentId: NEW_ID as never,
            find: "Newer.",
            content: "Newest.",
            tool_use_id: "w-late",
          },
          { ...responseContext(second), grant: grantFor(NEW_ID) },
        );
      } finally {
        fixture.branchCoordinator.withLeases = withLeases;
        fixture.branchStore.ensureThreadPeerBranch = ensure;
      }
      // An early Discard may let the write run against a fresh peer and fail as a missing
      // find, but the reply still names the discarded document; none crash.
      expect(late.isError).toBe(true);
      if (phase === "before the leases") expect(late.status).toBe("invalid_write");
      expect(JSON.stringify(late.result)).toContain("the user discarded this new document");
      expect(refused(await harness.commit(second))).toEqual([[NEW_ID, DOC]]);
    });
    it("22b: a first write losing to Discard all leaves no pin, so the instructed read and retry land in a fresh draft", async () => {
      const { responseId, review, write, core, context, fixture } = await setup();
      const withLeases = fixture.branchCoordinator.withLeases;
      let once = true;
      fixture.branchCoordinator.withLeases = (async (...args: Parameters<typeof withLeases>) => {
        if (once && args[0].length === 2) {
          once = false;
          await review.discardAll();
        }
        return withLeases.apply(fixture.branchCoordinator, args);
      }) as typeof withLeases;
      let first: Awaited<ReturnType<typeof write>>;
      try {
        first = await write("green", "lime", "w-first");
      } finally {
        fixture.branchCoordinator.withLeases = withLeases;
      }
      expect(first).toMatchObject({ isError: true, status: "invalid_write" });
      expect(JSON.stringify(first.result)).toContain(DRAFT);
      expect(
        await core.read({ file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "r" }, context),
      ).toMatchObject({ status: "success" });
      expect(await write("green", "lime", "w-retry")).toMatchObject({ phase: "staged" });
      expect(refused(await harness.commit(responseId))).toEqual([]);
      expect(await review.list()).not.toEqual([]);
    });
    it("22c: a first write paused after its lease and before staging is refused at the write once Discard retires its peer", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      const prepare = fixture.links.prepare;
      let once = true;
      fixture.links.prepare = (async (...args: Parameters<typeof prepare>) => {
        if (once) {
          once = false;
          await review.discardItem(ALPHA_ID);
        }
        return prepare.apply(fixture.links, args);
      }) as typeof prepare;
      let paused: Awaited<ReturnType<typeof write>>;
      try {
        paused = await write("green", "lime", "w-paused");
      } finally {
        fixture.links.prepare = prepare;
      }
      expect(paused).toMatchObject({ isError: true, status: "invalid_write" });
      expect(JSON.stringify(paused.result)).toContain(EDIT);
      expect(refused(await harness.commit(responseId))).toEqual([]);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
      const next = responseContext(await createResponse(db, 3));
      expect(
        await fixture.collab.agentEdit().write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find: "green",
            content: "lime",
            tool_use_id: "w-replacement",
          },
          next,
        ),
      ).toMatchObject({ phase: "staged" });
    });
    it("19: a new reply writes through a fresh peer while the old retirement is held", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      let next: string | undefined;
      let nextSaved: Saved | undefined;
      let oldSaved: Saved | undefined;
      const remove = setCollabHook("discard.beforeRetirement", async () => {
        remove();
        oldSaved = await harness.commit(responseId);
        next = await createResponse(db, 3);
        expect(
          await fixture.collab.agentEdit().write(
            {
              command: "replace",
              file: "alpha.md",
              documentId: ALPHA_ID,
              find: "blue",
              content: "navy",
              tool_use_id: "w-new",
            },
            responseContext(next),
          ),
        ).toMatchObject({ phase: "staged" });
      });
      expect(await review.discardItem(ALPHA_ID)).toMatchObject({
        status: "discarded",
      });
      nextSaved = await harness.commit(next as string);
      expect(refused(oldSaved as Saved)).toEqual([[ALPHA_ID, EDIT]]);
      expect(refused(nextSaved)).toEqual([]);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nnavy\n\ngreen\n");
    });
    it("21: a same-reply write after the old peer's delayed retirement commits; the old write is receipted separately", async () => {
      const { fixture, branchId, responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-old")).toMatchObject({ phase: "staged" });
      const remove = setCollabHook("discard.beforeRetirement", async () => {
        remove();
        expect(await write("blue", "navy", "w-fresh")).toMatchObject({
          phase: "staged",
        });
      });
      expect(await review.discardItem(ALPHA_ID)).toMatchObject({
        status: "discarded",
      });
      const saved = await harness.commit(responseId);
      expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nnavy\n\ngreen\n");
    });
    it("8: a save with a concurrent upstream edit makes no nested acquisition and names the edit", async () => {
      const { fixture, branchId, responseId, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      await commitBranchEdit(fixture, branchId, { source: "writer" }, (doc) => {
        const paragraph = doc.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).insert(0, "Writer ");
      });
      const sections = harness.criticalSections;
      const withBranches = sections.withBranches;
      const inside = new AsyncLocalStorage<true>();
      let nested = 0;
      sections.withBranches = ((ids, run) =>
        withBranches.call(sections, ids, (lease) => {
          if (inside.getStore()) nested += 1;
          return inside.run(true, () => run(lease));
        })) as typeof withBranches;
      let saved: Saved;
      try {
        saved = await harness.commit(responseId);
      } finally {
        sections.withBranches = withBranches;
      }
      expect(nested).toBe(0);
      const receipt = saved.documents[0]?.receipts[0];
      expect(receipt?.result.status).toBe("success");
      expect(JSON.stringify(receipt?.result)).toContain("Writer");
      expect(JSON.stringify(receipt?.result)).not.toContain("awarenessDegraded");
    });
  });
});

__mergedSuite("inverse-integration.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/inverse-integration.db.test.ts.
  const NEW_ID = "00000000-0000-4000-8000-000000000830";

  const INVERSE = "an inverse removed the text it edited";

  type Saved = Awaited<ReturnType<ReturnType<typeof createHarness>["commit"]>>;

  /** Each write's document, status and message, in save order. */
  function receipts(saved: Saved) {
    return Object.fromEntries(
      saved.documents.flatMap((doc) =>
        doc.receipts.map((receipt) => [
          receipt.settlementId.split(":tool:")[1],
          receipt.result.status,
        ]),
      ),
    );
  }

  const messages = (saved: Saved) => JSON.stringify(saved.documents.map((doc) => doc.receipts));

  __mergedSuite("inverse integration (postgres)", () => {
    const db = createTestDatabase();
    let harness: ReturnType<typeof createHarness>;
    beforeEach(async () => {
      await resetDatabase(db);
      harness = createHarness(db);
    });
    afterEach(() => {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    });
    afterAll(() => closeDatabase(db));
    /** Counts acquisitions made while another is held. */
    function nestedAcquisitions() {
      const sections = harness.criticalSections;
      const withBranches = sections.withBranches;
      const inside = new AsyncLocalStorage<true>();
      const seen = { nested: 0 };
      sections.withBranches = ((ids, run) =>
        withBranches.call(sections, ids, (lease) => {
          if (inside.getStore()) seen.nested += 1;
          return inside.run(true, () => run(lease));
        })) as typeof withBranches;
      return {
        seen,
        restore() {
          sections.withBranches = withBranches;
        },
      };
    }
    async function claimCreate(draftId: string, documentId: string) {
      await db.insert(schema.documents).values({
        id: documentId as never,
        contextSourceId: SOURCE_ID,
        name: "created",
        extension: "",
        hidden: true,
      });
      await db.insert(schema.draftTreeChanges).values({
        draftId: draftId as never,
        nodeKind: "document",
        nodeId: documentId as never,
        created: true,
      });
    }
    const grantFor = (documentId: string, workId: string = WORK_ID, slug = "atomicity-work") => {
      const granted = testFileGrant(
        { kind: "draft", workId: workId as never, workSlug: slug },
        documentId,
      );
      return {
        ...granted,
        principal: { ...granted.principal, accountId: USER_ID as never },
        facts: { ...granted.facts, projectId: PROJECT_ID as never },
      };
    };
    it("18: rollback runs the pool, then the inverse, then the create's retraction, with no nested acquisition", async () => {
      const { fixture, branchId } = await stageDraft(
        db,
        harness,
        "red\n\nblue\n\ngreen",
        "replace",
        [["red", "gold"]],
      );
      const draftId = (await fixture.collab.draftReview.items({ workId: WORK_ID })).draftId;
      if (!draftId) throw new Error("No active draft");
      await claimCreate(draftId, NEW_ID);
      const reply = await createResponse(db, 2);
      const core = fixture.collab.agentEdit();
      const context = responseContext(reply);
      // An accepted draft part: the reply's Undo lands at once, ahead of the save.
      expect(
        await core.write({ command: "undo", file: "alpha.md", documentId: ALPHA_ID }, context),
      ).toMatchObject({ status: "success" });
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
      // The create is still staged, and another thread's peer sits on its draft branch.
      expect(
        await core.write(
          { command: "create", file: "created", documentId: NEW_ID as never, content: "New." },
          { ...context, grant: grantFor(NEW_ID), createdDocument: true },
        ),
      ).toMatchObject({ phase: "staged" });
      await seedSecondWork(fixture);
      await core.read(
        { file: "created", documentId: NEW_ID as never },
        {
          sessionId: THREAD_B_ID,
          threadId: THREAD_B_ID,
          turnId: TURN_ID,
          grant: grantFor(NEW_ID),
        },
      );
      const peersOfCreate = async () =>
        (await db.select().from(schema.documentBranches)).filter(
          (branch) => branch.documentId === NEW_ID,
        );
      expect((await peersOfCreate()).some((branch) => branch.threadId === THREAD_B_ID)).toBe(true);
      const { seen, restore } = nestedAcquisitions();
      try {
        const rolledBack = await fixture.collab.finalizeResponseRollback(
          { providerResponseId: reply, editScopeId: reply },
          { threadId: THREAD_ID, turnId: TURN_ID },
        );
        expect(rolledBack.stagedCreates.discarded).toEqual([NEW_ID]);
        // The inverse ran: the reply's accepted Undo part is out of the draft.
        expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nblue\n\ngreen\n");
        expect(
          await fixture.branchStore.retractCreatedDraftBranch({
            documentId: NEW_ID as never,
            draftId: draftId as never,
          }),
        ).toMatchObject({ outcome: "retracted" });
      } finally {
        restore();
      }
      expect(seen.nested).toBe(0);
      expect(await peersOfCreate()).toEqual([]);
    });
    it("22: a model write undo lands an inverse while another reply is staged: a write on its removals fails with its dependents, an independent one lands", async () => {
      const how = "model write undo" as const;
      const { fixture, branchId } = await stageDraft(
        db,
        harness,
        "red\n\nblue\n\ngreen",
        "replace",
        [
          ["red", "gold"],
          ["blue", "azure"],
        ],
      );
      const core = fixture.collab.agentEdit();
      const staged = await createResponse(db, 2);
      const write = (find: string, content: string, id: string) =>
        core.write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find,
            content,
            tool_use_id: id,
          },
          responseContext(staged),
        );
      expect(await write("azure", "cyan", "w-touch")).toMatchObject({ phase: "staged" });
      expect(await write("cyan", "teal", "w-dependent")).toMatchObject({
        phase: "staged",
      });
      expect(await write("green", "lime", "w-independent")).toMatchObject({
        phase: "staged",
      });
      if (how === "model write undo") {
        const undoContext = responseContext(await createResponse(db, 3));
        expect(
          await core.write(
            { command: "undo", file: "alpha.md", documentId: ALPHA_ID },
            undoContext,
          ),
        ).toMatchObject({ status: "success" });
      } else {
        expect(
          await fixture.collab.reverseTurn({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            direction: "undo",
            actor: { type: "user", userId: USER_ID },
          }),
        ).toMatchObject({ status: "reversed" });
      }
      const saved = await harness.commit(staged);
      expect(receipts(saved)).toEqual({
        "w-touch": "invalid_write",
        "w-dependent": "invalid_write",
        "w-independent": "success",
      });
      expect(messages(saved)).toContain(INVERSE);
      const text = await fixture.draftMarkdown(branchId);
      expect(text).toContain("lime");
      expect(text).not.toContain("cyan");
      expect(text).not.toContain("teal");
    });
    it("22: an ordinary writer deletion of the text a staged write edits admits that write", async () => {
      const { fixture, branchId } = await stageDraft(
        db,
        harness,
        "red\n\nblue\n\ngreen",
        "replace",
        [["red", "gold"]],
      );
      const staged = await createResponse(db, 2);
      expect(
        await fixture.collab.agentEdit().write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find: "green",
            content: "lime",
            tool_use_id: "w-lime",
          },
          responseContext(staged),
        ),
      ).toMatchObject({ phase: "staged" });
      await commitBranchEdit(fixture, branchId, { source: "writer" }, (doc: Y.Doc) => {
        const paragraph = doc.getXmlFragment("prosemirror").get(2) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).delete(0, 5);
      });
      const saved = await harness.commit(staged);
      expect(receipts(saved)).toEqual({ "w-lime": "success" });
    });
    it("6.4: model undo after the chat's Work moved refuses elsewhere and touches nothing", async () => {
      const { fixture, branchId } = await stageDraft(
        db,
        harness,
        "red\n\nblue\n\ngreen",
        "replace",
        [["red", "gold"]],
      );
      await seedSecondWork(fixture);
      await createDrafts({
        store: createDrizzleDraftStore(db),
        boundary: createDrizzleDraftWriteBoundary(db),
      }).ensureActiveForWrite({
        workId: WORK_B_ID,
        projectId: PROJECT_ID as never,
        threadId: THREAD_ID as never,
        userId: USER_ID as never,
      });
      const moved = {
        ...responseContext(await createResponse(db, 2)),
        grant: grantFor(ALPHA_ID, WORK_B_ID, "work-b"),
      };
      await fixture.collab
        .agentEdit()
        .read({ file: "alpha.md", documentId: ALPHA_ID, format: "edits" }, moved);
      expect(
        await fixture.collab
          .agentEdit()
          .write({ command: "undo", file: "alpha.md", documentId: ALPHA_ID }, moved),
      ).toMatchObject({ status: "cant_undo_elsewhere" });
      expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nblue\n\ngreen\n");
    });
    it("6.2: card Undo of a turn whose draft was discarded skips every part by name", async () => {
      const { fixture } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
        ["red", "gold"],
        ["blue", "azure"],
      ]);
      expect(await reviewDriver(fixture.collab.draftReview).discardAll()).toMatchObject({
        status: "discarded",
      });
      const outcome = await fixture.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(outcome).toMatchObject({ status: "expired", acceptedParts: 0 });
      expect(
        (outcome.skips ?? []).map((skip) => [skip.before, skip.after, skip.reason]).sort(),
      ).toEqual([
        ["blue", "azure", "discarded"],
        ["red", "gold", "discarded"],
      ]);
    });
    it("F8: card Undo of a drafted create inverts its text and leaves the item as an empty whole-item change", async () => {
      const { fixture } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
        ["red", "gold"],
      ]);
      const draftId = (await fixture.collab.draftReview.items({ workId: WORK_ID })).draftId;
      if (!draftId) throw new Error("No active draft");
      await claimCreate(draftId, NEW_ID);
      const reply = await createResponse(db, 2);
      expect(
        await fixture.collab.agentEdit().write(
          { command: "create", file: "created", documentId: NEW_ID as never, content: "New." },
          {
            ...responseContext(reply),
            grant: grantFor(NEW_ID),
            createdDocument: true,
          },
        ),
      ).toMatchObject({ phase: "staged" });
      expect(await harness.commit(reply)).toMatchObject({ status: "committed" });
      const item = () =>
        fixture.collab.draftReview.resolveItemByDocument({
          workId: WORK_ID,
          documentId: NEW_ID as never,
        });
      expect(await item()).toMatchObject({ item: { origin: "created" } });
      const turnUndo = await fixture.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(turnUndo).toMatchObject({ status: "reversed", skips: [] });
      const kept = await item();
      expect(kept).toMatchObject({
        listed: true,
        item: { origin: "created", wholeItem: true },
      });
      expect((await fixture.draftMarkdown(kept?.draftBranchId as string)).trim()).toBe("");
    });
  });
});
