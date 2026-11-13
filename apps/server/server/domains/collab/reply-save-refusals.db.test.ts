/**
 * Contract §2.6 DB cases: what a reply's staged writes become when the writer's Discard, Apply or an archive lands before the save.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - database-state refusal precedence between draft close and removal
 */

import { removedWriteRefusal } from "@meridian/agent-edit/integration";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { setTestHook } from "../../shared/test-hooks.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createBranches } from "./domain/branches.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  SOURCE_ID,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/collab-postgres-harness.js";
import {
  createResponse,
  responseContext,
  stageDraft,
} from "./test-support/document-edit-receipt-fixture.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";

const DRAFT = "Write did not land: the user discarded this draft. Re-read and retry.";
const _EDIT = "Write did not land: the user discarded the text it edited. Re-read and retry.";

type Saved = Awaited<ReturnType<ReturnType<typeof createHarness>["commit"]>>;
/** A Discard leaves the creation's document in no view with no removal record: the draft's own copy answers. */
const CREATE_DISCARDED =
  "Write did not land: the user discarded this new document. Re-read and retry.";
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
  afterEach(async () => {
    await harness.dispose();
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
  /** A document the Work's branch created in its draft view and has not applied. */
  async function draftedCreate(documentId: string, name: string) {
    const branch = await branchesOf().ensureActiveForWrite({
      owner: { kind: "work", workId: WORK_ID },
      projectId: PROJECT_ID as never,
      threadId: THREAD_ID as never,
      userId: USER_ID as never,
    });
    await treeSeeder(db).document(SOURCE_ID, name, {
      id: documentId,
      view: { draft: branch.id },
      actor: `agent:${THREAD_ID}/${TURN_ID}`,
    });
    await seedEmptyAuthority(documentId);
  }
  /** A create's own step: the document's empty authority. */
  async function seedEmptyAuthority(documentId: string) {
    await createDrizzleCollabPersistence(db).seeds.seedInitialDocument(
      documentId as never,
      Y.encodeStateAsUpdate(new Y.Doc()),
    );
  }
  const NEW_ID = "00000000-0000-4000-8000-000000000830";
  const grantFor = (documentId: string, workId = WORK_ID, slug = "atomicity-work") => {
    const granted = testFileGrant(
      { kind: "draft", owner: { kind: "work", workId }, ownerHandle: slug },
      documentId,
    );
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
    await draftedCreate(NEW_ID, "created");
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

  it("13: Discard of a created item while staged refuses discarded_document", async () => {
    const { second, review } = await createdThenStaged();
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    const saved = await harness.commit(second);
    expect(refused(saved)).toEqual([[NEW_ID, CREATE_DISCARDED]]);
  });

  it("17: a save between a Discard's commit and its retirement is refused by draft state", async () => {
    const { second, review } = await createdThenStaged();
    let saved: Saved | undefined;
    const remove = setTestHook("draft.beforeRetirement", async () => {
      remove();
      saved = await harness.commit(second);
    });
    expect(await review.discardItem(NEW_ID)).toMatchObject({ status: "discarded" });
    expect(refused(saved as Saved)).toEqual([[NEW_ID, CREATE_DISCARDED]]);
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
});
