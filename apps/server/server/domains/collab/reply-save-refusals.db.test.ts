/**
 * Contract §2.6 DB cases: what a reply's staged writes become when the writer's Discard, Apply
 * or an archive lands before the save. A refusal is a receipt, never a thrown save.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { drizzleFileAccess, testFileGrant } from "../../test-support/file-grants.js";
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
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import {
  seedSecondWork,
  THREAD_B_ID,
  TURN_B_ID,
  WORK_B_ID,
} from "./test-support/cross-work-probe-harness.js";
import {
  createResponse,
  responseContext,
  stageDraft,
} from "./test-support/document-edit-receipt-fixture.js";
import { commitBranchEdit, reviewDriver } from "./test-support/draft-review-requests.js";

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

describe("reply save refusals (postgres)", () => {
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
    expect(saved).toMatchObject({ status: "committed", documents: [{ updateCount: 2 }] });
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
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
    expect(saved.documents.map((doc) => doc.documentId).sort()).toEqual([ALPHA_ID, BETA_ID].sort());
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
  async function claimCreate(documentId: string, name: string, workId: WorkId, threadId: string) {
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
      contextSourceId: SOURCE_ID as never,
      parentFolderId: null,
      name,
      extension: "",
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
    await claimCreate(documentId, name, WORK_ID, THREAD_ID);
  }
  /** Work B's draft claims the same hidden create, as two chats creating one path would. */
  async function shareHiddenCreate(fixture: Fixture) {
    await seedSecondWork(fixture);
    await claimCreate(NEW_ID, "created", WORK_B_ID, THREAD_B_ID);
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
    const { fixture, core } = base;
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

  it("15: Discard of a revealed create refuses discarded_edit, not discarded_document", async () => {
    const { second, review, fixture } = await createdThenStaged();
    await db
      .update(schema.documents)
      .set({ hidden: false })
      .where(eq(schema.documents.id, NEW_ID as never));
    await db
      .delete(schema.draftTreeChanges)
      .where(eq(schema.draftTreeChanges.nodeId, NEW_ID as never));
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(second);
    expect(refused(saved)).toEqual([[NEW_ID, EDIT]]);
    void fixture;
  });

  it("10: a pooled peer and a per-change Discard: a fresh read shows none of the discarded text and the write lands", async () => {
    const { fixture, branchId, responseId, context, core, review } = await setup();
    const preview = await review.activePreview(ALPHA_ID);
    const azure = preview.operations.find((op) => op.afterExcerpt === "azure");
    await review.discardChanges(ALPHA_ID, preview, [azure?.operationId as string]);
    const read = await core.read(
      { file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-10" },
      context,
    );
    expect(JSON.stringify(read.result)).not.toContain("azure");
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "gold",
          content: "silver",
          tool_use_id: "w-10",
        },
        context,
      ),
    ).toMatchObject({ phase: "staged" });
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toBe("silver\n\nblue\n\ngreen\n");
    expect(await harness.branchGeneration(branchId)).toBe(2);
  });

  it("11: Apply all while staged drains the draft, which stays active, and the write lands in it", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.applyAll()).toMatchObject({ status: "completed" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nazure\n\ngreen\n");
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\nlime\n");
    expect((await fixture.collab.draftReview.items({ workId: WORK_ID })).draftId).not.toBeNull();
  });

  it("12: switching to direct after Apply all while staged still lands the write in the draft", async () => {
    const { fixture, branchId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.applyAll()).toMatchObject({ status: "completed" });
    await db
      .update(schema.works)
      .set({ aiWriteMode: "direct" })
      .where(eq(schema.works.id, WORK_ID));
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(branchId)).toBe("gold\n\nazure\n\nlime\n");
  });

  it("9 and 14: an item Discard refuses this Work's staged writes, never another Work's on the same document", async () => {
    const { fixture, responseId, review, write } = await setup();
    await seedSecondWork(fixture);
    const core = fixture.collab.agentEdit();
    const second = await db
      .insert(schema.modelResponses)
      .values({
        id: crypto.randomUUID() as never,
        turnId: TURN_B_ID,
        sequence: 1,
        provider: "mock",
        model: "mock",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      })
      .returning({ id: schema.modelResponses.id });
    const responseB = second[0]?.id as string;
    const contextB = {
      sessionId: THREAD_B_ID,
      threadId: THREAD_B_ID,
      turnId: TURN_B_ID,
      responseIdentity: { providerResponseId: responseB, editScopeId: responseB },
      grant: grantFor(ALPHA_ID, WORK_B_ID, "work-b"),
    };
    await core.read(
      { file: "alpha.md", documentId: ALPHA_ID },
      { ...contextB, responseIdentity: undefined },
    );
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "green",
          content: "emerald",
          tool_use_id: "w-b",
        },
        contextB,
      ),
    ).toMatchObject({ phase: "staged" });
    expect(await write("green", "lime", "w-a")).toMatchObject({ phase: "staged" });
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, EDIT]]);
    expect(refused(await harness.commit(responseB))).toEqual([]);
    const beta = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_B_ID);
    beta.doc.destroy();
    expect(await fixture.draftMarkdown(beta.branchId)).toBe("red\n\nblue\n\nemerald\n");
    // A later reply writes the document again, through a fresh peer on the reset branch.
    const next = await createResponse(db, 3);
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "blue",
          content: "navy",
          tool_use_id: "w-later",
        },
        responseContext(next),
      ),
    ).toMatchObject({ phase: "staged" });
    expect(refused(await harness.commit(next))).toEqual([]);
    const mine = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    mine.doc.destroy();
    expect(await fixture.draftMarkdown(mine.branchId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  it("16: a per-change Discard racing a peer pull never shows its text on the next read", async () => {
    const { fixture, responseId, review, core } = await setup();
    const peer = await fixture.branchStore.resolveThreadBranch(ALPHA_ID, THREAD_ID);
    peer.doc.destroy();
    const preview = await review.activePreview(ALPHA_ID);
    const azure = preview.operations.find((op) => op.afterExcerpt === "azure");
    const readBranch = fixture.branchCoordinator.readBranch;
    let armed = true;
    fixture.branchCoordinator.readBranch = async (branchId, fn) => {
      const result = await readBranch.call(fixture.branchCoordinator, branchId, fn);
      if (armed && branchId === peer.branchId) {
        armed = false;
        await review.discardChanges(ALPHA_ID, preview, [azure?.operationId as string]);
      }
      return result;
    };
    try {
      const read = await core.read(
        { file: "alpha.md", documentId: ALPHA_ID, tool_use_id: "read-16" },
        responseContext(await createResponse(db, 3)),
      );
      expect(armed).toBe(false);
      expect(JSON.stringify(read.result)).not.toContain("azure");
    } finally {
      fixture.branchCoordinator.readBranch = readBranch;
    }
    void responseId;
  });

  describe("17: a save between a Discard's commit and its retirement is refused by branch state", () => {
    it("an edited document refuses discarded_edit", async () => {
      const { responseId, review, write } = await setup();
      expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
      let saved: Saved | undefined;
      const remove = setCollabHook("discard.beforeRetirement", async () => {
        remove();
        saved = await harness.commit(responseId);
      });
      expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
      expect(refused(saved as Saved)).toEqual([[ALPHA_ID, EDIT]]);
    });

    it.each([
      { name: "a revealed create", reveal: true, other: false, copy: EDIT },
      { name: "a hidden create another Work's draft uses", reveal: false, other: true, copy: DOC },
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
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
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
      expect(await write("blue", "navy", "w-fresh")).toMatchObject({ phase: "staged" });
    });
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
    expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  it("14: a hidden create shared by two Works: Discarding it in Work A leaves Work B's staged write to land", async () => {
    const { fixture, core, review } = await createdThenStaged();
    await shareHiddenCreate(fixture);
    const [responseRow] = await db
      .insert(schema.modelResponses)
      .values({
        id: crypto.randomUUID() as never,
        turnId: TURN_B_ID,
        sequence: 1,
        provider: "mock",
        model: "mock",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      })
      .returning({ id: schema.modelResponses.id });
    const responseB = responseRow?.id as string;
    const contextB = {
      sessionId: THREAD_B_ID,
      threadId: THREAD_B_ID,
      turnId: TURN_B_ID,
      responseIdentity: { providerResponseId: responseB, editScopeId: responseB },
      grant: grantFor(NEW_ID, WORK_B_ID, "work-b"),
    };
    await core.read(
      { file: "created", documentId: NEW_ID as never },
      { ...contextB, responseIdentity: undefined },
    );
    expect(
      await core.write(
        {
          command: "create",
          file: "created",
          documentId: NEW_ID as never,
          content: "Work B's.",
          overwrite: true,
          tool_use_id: "w-b",
        },
        { ...contextB, createdDocument: false },
      ),
    ).toMatchObject({ phase: "staged" });
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    expect(refused(await harness.commit(responseB))).toEqual([]);
    const [row] = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, NEW_ID as never));
    expect(row?.deletedAt).toBeNull();
    const b = await fixture.branchStore.resolveWorkDraftBranchForThread(
      NEW_ID as never,
      THREAD_B_ID,
    );
    b.doc.destroy();
    expect(await fixture.draftMarkdown(b.branchId)).toContain("Work B's.");
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

  it("6: archiving the Work while staged refuses its writes with the denial copy and saves the others", async () => {
    harness.destroyWarmState();
    harness = createHarness(db, { fileAccess: drizzleFileAccess(db) });
    const { fixture, responseId, write, core, context } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    const granted = testFileGrant({ kind: "live" }, BETA_ID);
    expect(
      await core.write(
        {
          command: "create",
          file: "beta.md",
          documentId: BETA_ID,
          content: "Beta live.",
          overwrite: true,
          tool_use_id: "w-beta",
        },
        {
          ...context,
          createdDocument: false,
          grant: {
            ...granted,
            principal: { ...granted.principal, accountId: USER_ID as never },
            facts: { ...granted.facts, projectId: PROJECT_ID as never },
          },
        },
      ),
    ).toMatchObject({ phase: "staged" });
    await db
      .update(schema.works)
      .set({ archivedAt: new Date() })
      .where(eq(schema.works.id, WORK_ID));
    const saved = await harness.commit(responseId);
    expect(saved.refused).toHaveLength(1);
    expect(saved.refused[0]).toMatchObject({
      documentId: ALPHA_ID,
      denial: { denied: true, reason: "work_archived" },
    });
    expect(saved.documents.map((doc) => [doc.documentId, doc.receipts[0]?.result.status])).toEqual([
      [BETA_ID, "success"],
    ]);
    void fixture;
  });
});
