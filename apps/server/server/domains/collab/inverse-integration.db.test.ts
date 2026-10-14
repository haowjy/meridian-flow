/**
 * Contract §2.6 cases 18 and 22 and §6.5: a failed reply's rollback order, an inverse landing
 * on a draft while another reply is staged, and what a Work or discard change does to undo.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "./adapters/drizzle-drafts.js";
import { createDrafts } from "./domain/drafts.js";
import {
  ALPHA_ID,
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

describe("inverse integration (postgres)", () => {
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
    const { fixture, branchId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
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
      { sessionId: THREAD_B_ID, threadId: THREAD_B_ID, turnId: TURN_ID, grant: grantFor(NEW_ID) },
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

  it.each([
    "model write undo",
    "card Undo",
  ] as const)("22: a %s lands an inverse while another reply is staged: a write on its removals fails with its dependents, an independent one lands", async (how) => {
    const { fixture, branchId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
      ["blue", "azure"],
    ]);
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
    expect(await write("cyan", "teal", "w-dependent")).toMatchObject({ phase: "staged" });
    expect(await write("green", "lime", "w-independent")).toMatchObject({ phase: "staged" });

    if (how === "model write undo") {
      const undoContext = responseContext(await createResponse(db, 3));
      expect(
        await core.write({ command: "undo", file: "alpha.md", documentId: ALPHA_ID }, undoContext),
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
    const { fixture, branchId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
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
    const { fixture, branchId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
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
      await fixture.collab
        .agentEdit()
        .write(
          { command: "create", file: "created", documentId: NEW_ID as never, content: "New." },
          { ...responseContext(reply), grant: grantFor(NEW_ID), createdDocument: true },
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
    expect(kept).toMatchObject({ listed: true, item: { origin: "created", wholeItem: true } });
    expect((await fixture.draftMarkdown(kept?.draftBranchId as string)).trim()).toBe("");
  });
});
