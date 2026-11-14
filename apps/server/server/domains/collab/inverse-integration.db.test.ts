/**
 * Contract §6.5: what a Work or discard change does to undo.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - durable inverse ownership (kb/wiki/architecture/collaboration/agent-editing-and-reversal.md#reversal-is-a-forward-edit)
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
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
} from "./test-support/collab-postgres-harness.js";
import { seedSecondWork, WORK_B_ID } from "./test-support/cross-work-probe-harness.js";
import {
  createResponse,
  responseContext,
  stageDraft,
} from "./test-support/document-edit-receipt-fixture.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";

const NEW_ID = "00000000-0000-4000-8000-000000000830";
const _INVERSE = "an inverse removed the text it edited";

describe("inverse integration (postgres)", () => {
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

  async function claimCreate(branchId: string, documentId: string) {
    await db.insert(schema.documents).values({
      id: documentId as never,
      contextSourceId: SOURCE_ID,
      name: "created",
      extension: "",
      hidden: true,
    });
    await db.insert(schema.branchTreeChanges).values({
      branchId: branchId as never,
      nodeKind: "document",
      nodeId: documentId as never,
      created: true,
    });
  }

  const grantFor = (documentId: string, workId: string = WORK_ID, slug = "atomicity-work") => {
    const granted = testFileGrant(
      { kind: "draft", owner: { kind: "work", workId: workId as never }, ownerHandle: slug },
      documentId,
    );
    return {
      ...granted,
      principal: { ...granted.principal, accountId: USER_ID as never },
      facts: { ...granted.facts, projectId: PROJECT_ID as never },
    };
  };

  it("6.4: model undo after the chat's Work moved lands in the edit's Work", async () => {
    const { fixture, draftId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
    await seedSecondWork(fixture);
    await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, WORK_B_ID);
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
    ).toMatchObject({ status: "success" });
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
    expect(
      await fixture.collab
        .agentEdit()
        .write({ command: "redo", file: "alpha.md", documentId: ALPHA_ID }, moved),
    ).toMatchObject({ status: "success" });
    expect(await fixture.draftMarkdown(draftId)).toBe("gold\n\nblue\n\ngreen\n");
    expect(
      await fixture.collab
        .agentEdit()
        .write({ command: "revert", edit: "e1", file: "alpha.md", documentId: ALPHA_ID }, moved),
    ).toMatchObject({ status: "success" });
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
    expect(
      (await db.select().from(schema.branches)).filter(
        (branch) => branch.originWorkId === WORK_B_ID,
      ),
    ).toEqual([]);
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
      (outcome.skips ?? [])
        .map((skip) => (skip.kind === "text" ? [skip.before, skip.after, skip.cause] : []))
        .sort(),
    ).toEqual([
      // Discard released the draft's bytes. Live has unrelated item identities, so
      // receipts cannot manufacture snippets from it.
      ["", "", "discarded"],
      ["", "", "discarded"],
    ]);
  });

  it("F8: card Undo of a drafted create inverts its text and leaves the item as an empty whole-item change", async () => {
    const { fixture } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
    const branchId = (
      await fixture.collab.draftReview.items({ owner: { kind: "work", workId: WORK_ID } })
    ).branchId;
    if (!branchId) throw new Error("No active branch");
    await claimCreate(branchId, NEW_ID);
    await fixture.provisionDraft(NEW_ID as never);
    const reply = await createResponse(db, 2);
    expect(
      await fixture.collab
        .agentEdit()
        .write(
          { command: "create", file: "created", documentId: NEW_ID as never, content: "New." },
          { ...responseContext(reply), grant: grantFor(NEW_ID) },
        ),
    ).toMatchObject({ status: "success" });
    const item = () =>
      fixture.collab.draftReview.resolveItemByDocument({
        owner: { kind: "work", workId: WORK_ID },
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
    expect((await fixture.draftMarkdown(kept?.draftId as string)).trim()).toBe("");
  });
});
