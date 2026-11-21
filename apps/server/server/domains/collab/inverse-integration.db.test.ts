/**
 * Contract §6.5: what a Work or discard change does to undo.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - durable inverse ownership (kb/wiki/architecture/collaboration/agent-editing-and-reversal.md#reversal-is-a-forward-edit)
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantInProject, testFileGrant } from "../../test-support/file-grants.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
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
  WORK_DRAFT_ID,
  WORK_ID,
} from "./test-support/collab-postgres-harness.js";
import {
  seedSecondWork,
  WORK_B_DRAFT_ID,
  WORK_B_ID,
} from "./test-support/cross-work-probe-harness.js";
import {
  createResponse,
  responseContext,
  stageDraft,
} from "./test-support/document-edit-receipt-fixture.js";
import { pressDriver } from "./test-support/press-requests.js";

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

  /** The Work's draft creates the chapter, as ContextFS leaves a model's create in a draft-mode Work. */
  async function claimCreate(draftId: string, documentId: string) {
    await treeSeeder(db).document(SOURCE_ID, "created", {
      id: documentId,
      view: { draft: draftId },
      actor: `agent:${THREAD_ID}/${TURN_ID}`,
    });
  }

  const grantFor = (
    documentId: string,
    work: { id: string; draft: string } = { id: WORK_ID, draft: WORK_DRAFT_ID },
    slug = "atomicity-work",
  ) => {
    const granted = testFileGrant(
      {
        kind: "draft",
        draftId: work.draft,
        owner: { kind: "work", workId: work.id as never },
        ownerHandle: slug,
      },
      documentId,
    );
    return grantInProject(granted, PROJECT_ID, USER_ID);
  };

  it("6.4: model undo after the chat's Work moved lands in the edit's Work", async () => {
    const { fixture } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
    await seedSecondWork(fixture);
    await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, WORK_B_ID);
    const moved = {
      ...responseContext(await createResponse(db, 2)),
      grant: grantFor(ALPHA_ID, { id: WORK_B_ID, draft: WORK_B_DRAFT_ID }, "work-b"),
    };
    await fixture.collab
      .agentEdit()
      .read({ file: "alpha.md", documentId: ALPHA_ID, format: "edits" }, moved);
    expect(
      await fixture.collab
        .agentEdit()
        .write({ command: "undo", file: "alpha.md", documentId: ALPHA_ID }, moved),
    ).toMatchObject({ status: "success" });
    expect(await fixture.workMarkdown()).toBe("red\n\nblue\n\ngreen\n");
  });

  it("6.2: card Undo of a turn whose draft was discarded takes nothing back", async () => {
    const { fixture } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
      ["blue", "azure"],
    ]);
    expect(await pressDriver(fixture.collab.presses).discard(ALPHA_ID)).toMatchObject({
      status: "pressed",
      items: [{ node: ALPHA_ID, text: true }],
    });
    const outcome = await fixture.collab.reverseTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actor: { type: "user", userId: USER_ID },
    });
    expect(outcome).toMatchObject({ status: "expired" });
  });

  it("F8: card Undo of a drafted create inverts its text and leaves the item as an empty whole-item change", async () => {
    const { fixture } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
    await claimCreate(WORK_DRAFT_ID, NEW_ID);
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
      fixture.collab.draftReview.resolveItemInDraft({
        draftId: WORK_DRAFT_ID,
        documentId: NEW_ID as never,
      });
    expect(await item()).toMatchObject({ item: { origin: "created" } });
    const turnUndo = await fixture.collab.reverseTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actor: { type: "user", userId: USER_ID },
    });
    expect(turnUndo).toMatchObject({ status: "reversed" });
    const kept = await item();
    expect(kept).toMatchObject({ listed: true, item: { origin: "created", wholeItem: true } });
    expect((await fixture.workMarkdown(NEW_ID)).trim()).toBe("");
  });
});
