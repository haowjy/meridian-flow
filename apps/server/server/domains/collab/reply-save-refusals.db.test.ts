/**
 * Contract §2.6 DB cases: what a reply's staged writes become when the writer's Discard, Apply
 * or an archive lands before the save. A refusal is a receipt, never a thrown save.
 */

import { removedWriteRefusal } from "@meridian/agent-edit/integration";
import type { WorkId } from "@meridian/contracts/runtime";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { setTestHook } from "../../shared/test-hooks.js";
import { drizzleFileAccess, testFileGrant } from "../../test-support/file-grants.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createBranches } from "./domain/branches.js";
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
import { reviewDriver } from "./test-support/draft-review-requests.js";

const DRAFT = "Write did not land: the user discarded this draft. Re-read and retry.";
const EDIT = "Write did not land: the user discarded the text it edited. Re-read and retry.";
const DOC = "Write did not land: the user discarded this new document. Re-read and retry.";

type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
type Saved = Awaited<ReturnType<ReturnType<typeof createHarness>["commit"]>>;
/** A Discard that released the creation refuses with the removal record's copy, never a retry. */
const REMOVED =
  "This file was discarded from the draft before this reply was saved, so this change wasn't made.";
/** Each refused write's document and the copy it carries, in save order. */
function refused(saved: Saved) {
  return [
    ...saved.documents.flatMap((doc) =>
      doc.receipts.flatMap((receipt) =>
        receipt.result.status === "invalid_write" ? [[doc.documentId, receipt.result.message]] : [],
      ),
    ),
    ...("refused" in saved ? saved.refused : []).flatMap((refusal) =>
      "removed" in refusal
        ? [[refusal.documentId, removedWriteRefusal(refusal.removed).message]]
        : [],
    ),
  ];
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
    const { fixture, draftId, responseId, review, write } = await setup();
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
    expect(await fixture.draftMarkdown(draftId)).toBe("silver\n\nblue\n\nlime\n");
    expect(await harness.draftGeneration(draftId)).toBe(2);
  });

  it("3: Discard all while staged refuses the save with one receipt per write and nothing live", async () => {
    const { fixture, draftId, responseId, review, write } = await setup();
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
    expect(await fixture.draftMarkdown(draftId)).toContain("gold");
  });

  it("2: after two reforks and a prepared read, only edits on discarded text fail", async () => {
    const { fixture, draftId, responseId, review, write, core, context } = await setup();
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
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\nlime\n");
  });

  it("4: a mixed reply saves its other document and receipts the refused one", async () => {
    const { fixture, draftId, responseId, review, write, core, context } = await setup();
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
    const beta = await fixture.draftStore.resolveWorkDraftForThread(BETA_ID, THREAD_ID);
    expect(await fixture.draftMarkdown(beta.draftId)).toBe("Beta staged.\n");
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
  });

  it("5: a write after Discard all in the same reply lands in a fresh draft beside the first refusal", async () => {
    const { fixture, draftId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.discardAll()).toMatchObject({ status: "discarded" });
    const later = await write("blue", "navy", "w-blue");
    expect(later).toMatchObject({ phase: "staged" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, DRAFT]]);
    expect(saved.documents[0]?.receipts).toHaveLength(2);
    const fresh = await fixture.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID);
    expect(fresh.draftId).not.toBe(draftId);
    expect(await fixture.draftMarkdown(fresh.draftId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  const branchesOf = () =>
    createBranches({
      store: createDrizzleBranchStore(db),
      boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
    });
  /** Marks `documentId` as created by `workId`'s active branch, making that branch if need be. */
  async function claimCreate(documentId: string, workId: WorkId, threadId: string) {
    const branch = await branchesOf().ensureActiveForWrite({
      workId,
      projectId: PROJECT_ID as never,
      threadId: threadId as never,
      userId: USER_ID as never,
    });
    await db.insert(schema.branchTreeChanges).values({
      branchId: branch.id,
      nodeKind: "document",
      nodeId: documentId as never,
      created: true,
    });
  }
  /** A document the branch created and has not revealed: hidden, with its tree row. */
  async function hiddenCreate(documentId: string, name: string) {
    await db.insert(schema.documents).values({
      id: documentId as never,
      contextSourceId: SOURCE_ID,
      name,
      extension: "",
      hidden: true,
    });
    await seedEmptyAuthority(documentId);
    await claimCreate(documentId, WORK_ID, THREAD_ID);
  }
  /** A create's own step: the document's empty authority. */
  async function seedEmptyAuthority(documentId: string) {
    await createDrizzleCollabPersistence(db).seeds.seedInitialDocument(
      documentId as never,
      Y.encodeStateAsUpdate(new Y.Doc()),
    );
  }
  /** Work B's branch claims the same hidden create, as two chats creating one path would. */
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

  /** A reply that created `NEW_ID` in the branch and saved, then a second reply staging an edit on it. */
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
    expect(refused(saved)).toEqual([[NEW_ID, REMOVED]]);
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
      .delete(schema.branchTreeChanges)
      .where(eq(schema.branchTreeChanges.nodeId, NEW_ID as never));
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(second);
    expect(refused(saved)).toEqual([[NEW_ID, EDIT]]);
    void fixture;
  });

  it("15b: another Work revealing the create before Discard's transaction keeps the draft and refuses discarded_edit", async () => {
    const { second, review, fixture } = await createdThenStaged();
    const remove = setTestHook("discard.beforeCommitScope", async () => {
      remove();
      await db
        .update(schema.documents)
        .set({ hidden: false })
        .where(eq(schema.documents.id, NEW_ID as never));
    });
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    expect(refused(await harness.commit(second))).toEqual([[NEW_ID, EDIT]]);
    // The branch's own draft, by kind: the closed thread peer shares the document, and an
    // unordered select returns whichever row Postgres happens to place first.
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, NEW_ID as never),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    expect(documentDraft?.status).toBe("active");
    // Reset from live, not closed: the draft holds exactly what the revealed document does.
    expect(await fixture.draftMarkdown(documentDraft?.id as string)).toBe(
      await harness.liveMarkdown(NEW_ID),
    );
  });

  it("11: Apply all while staged drains the branch, which stays active, and the write lands in its draft even once the chat writes direct", async () => {
    const { fixture, draftId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.applyAll()).toMatchObject({ status: "completed" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nazure\n\ngreen\n");
    await db
      .update(schema.threads)
      .set({ aiWriteMode: "direct" })
      .where(eq(schema.threads.id, THREAD_ID as never));
    expect(refused(await harness.commit(responseId))).toEqual([]);
    expect(await fixture.draftMarkdown(draftId)).toBe("gold\n\nazure\n\nlime\n");
    expect((await fixture.collab.draftReview.items({ workId: WORK_ID })).branchId).not.toBeNull();
  });

  it("11b: item Discard of a drained item still drops the staged write of a reply opened after Apply", async () => {
    const { fixture, draftId, responseId, review, write } = await setup();
    expect(await review.applyAll()).toMatchObject({ status: "completed" });
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, EDIT]]);
    expect(await fixture.draftMarkdown(draftId)).toBe("gold\n\nazure\n\ngreen\n");
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
    const beta = await fixture.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_B_ID);
    expect(await fixture.draftMarkdown(beta.draftId)).toBe("red\n\nblue\n\nemerald\n");
    // A later reply writes the document again, through a fresh peer on the reset draft.
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
    const mine = await fixture.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID);
    expect(await fixture.draftMarkdown(mine.draftId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  it("22: a write landing between Discard all's commit and its retirement gets the named refusal, not an internal error", async () => {
    const { responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-old")).toMatchObject({ phase: "staged" });
    let late: Awaited<ReturnType<typeof write>> | undefined;
    const remove = setTestHook("draft.beforeRetirement", async () => {
      remove();
      late = await write("blue", "navy", "w-late");
    });
    expect(await review.discardAll()).toMatchObject({ status: "discarded" });
    expect(late).toMatchObject({ isError: true, status: "invalid_write" });
    expect(JSON.stringify(late?.result)).toContain(DRAFT);
    expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, DRAFT]]);
  });

  it("23: an item Discard retiring the peer between a write's capture and its pull is named, not an internal error", async () => {
    const { responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-old")).toMatchObject({ phase: "staged" });
    let once = true;
    const unhook = setTestHook("draft.beforeAccess", async () => {
      if (once) {
        once = false;
        await review.discardItem(ALPHA_ID);
      }
    });
    let late: Awaited<ReturnType<typeof write>>;
    try {
      late = await write("blue", "navy", "w-late");
    } finally {
      unhook();
    }
    expect(late).toMatchObject({ isError: true, status: "invalid_write" });
    expect(JSON.stringify(late.result)).toContain(EDIT);
    expect(refused(await harness.commit(responseId))).toEqual([[ALPHA_ID, EDIT]]);
  });

  // The last-use Discard lands on either side of the write's identity step: after its ensure,
  // and before its room read.
  const ensurePhases = ["after the ensure", "before the room read"] as const;
  it.each(
    ensurePhases.flatMap((phase) => [
      { phase, other: false, name: "last use deletes the draft rows" },
      {
        phase,
        other: true,
        name: "another Work's branch still uses the create, so its rows close",
      },
    ]),
  )("23b: Discard of a hidden create $phase of a write names the document ($name)", async ({
    phase,
    other,
  }) => {
    const { second, review, fixture, core } = await createdThenStaged();
    if (other) {
      await seedSecondWork(fixture);
      await shareHiddenCreate(fixture);
    }
    const ensure = fixture.draftStore.ensureThreadPeerDraft;
    let once = true;
    const discardOnce = async () => {
      if (!once) return;
      once = false;
      await review.discardItem(NEW_ID);
    };
    fixture.draftStore.ensureThreadPeerDraft = (async (...args: Parameters<typeof ensure>) => {
      const peer = await ensure.apply(fixture.draftStore, args);
      if (phase === "after the ensure") await discardOnce();
      return peer;
    }) as typeof ensure;
    const unhook = setTestHook("draft.beforeAccess", async () => {
      if (phase === "before the room read") await discardOnce();
    });
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
      unhook();
      fixture.draftStore.ensureThreadPeerDraft = ensure;
    }
    expect(late).toMatchObject({ isError: true, status: "invalid_write" });
    expect(JSON.stringify(late.result)).toContain(
      other ? "the user discarded this new document" : REMOVED,
    );
    expect(refused(await harness.commit(second))).toEqual([[NEW_ID, other ? DOC : REMOVED]]);
  });

  it("22b: a first write losing to Discard all leaves no pin, so the instructed read and retry land in a fresh draft", async () => {
    const { responseId, review, write, core, context } = await setup();
    let once = true;
    const unhook = setTestHook("draft.beforeAccess", async () => {
      if (once) {
        once = false;
        await review.discardAll();
      }
    });
    let first: Awaited<ReturnType<typeof write>>;
    try {
      first = await write("green", "lime", "w-first");
    } finally {
      unhook();
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

  it("22c: a first write paused after its capture and before staging is refused at the write once Discard retires its peer", async () => {
    const { fixture, draftId, responseId, review, write } = await setup();
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
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
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
    const { fixture, draftId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    let next: string | undefined;
    let oldSaved: Saved | undefined;
    const remove = setTestHook("draft.beforeRetirement", async () => {
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
    const nextSaved = await harness.commit(next as string);
    expect(refused(oldSaved as Saved)).toEqual([[ALPHA_ID, EDIT]]);
    expect(refused(nextSaved)).toEqual([]);
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  it("21: a same-reply write after the old peer's delayed retirement commits; the old write is receipted separately", async () => {
    const { fixture, draftId, responseId, review, write } = await setup();
    expect(await write("green", "lime", "w-old")).toMatchObject({ phase: "staged" });
    const remove = setTestHook("draft.beforeRetirement", async () => {
      remove();
      expect(await write("blue", "navy", "w-fresh")).toMatchObject({ phase: "staged" });
    });
    expect(await review.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(responseId);
    expect(refused(saved)).toEqual([[ALPHA_ID, EDIT]]);
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nnavy\n\ngreen\n");
  });

  it("6: archiving the Work while staged refuses its writes with the denial copy and saves the others", async () => {
    harness.destroyWarmState();
    harness = createHarness(db, { fileAccess: drizzleFileAccess(db) });
    const { fixture, responseId, write, core, context } = await setup();
    expect(await write("green", "lime", "w-green")).toMatchObject({ phase: "staged" });
    const granted = testFileGrant({ kind: "live" }, BETA_ID);
    await seedEmptyAuthority(BETA_ID);
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
    if (!("refused" in saved)) throw new Error("the save carries no refusals");
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
