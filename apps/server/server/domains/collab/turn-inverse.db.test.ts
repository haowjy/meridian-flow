import { LIVE } from "@meridian/project-tree";
import { afterAll, beforeEach, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";
import { treeListOfSource, treeSeeder } from "../../test-support/tree-seed.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createTestDatabase,
  resetDatabase,
  SOURCE_ID,
  THREAD_ID,
  TURN_ID,
  WORK_DRAFT_ID,
  WORK_ID,
} from "./test-support/collab-postgres-harness.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it("a document in no view (deleted after its edit) does not stop another document's receipt from offering Undo", async () => {
  const { harness, view, context } = await fixture();
  try {
    const betaContext = {
      ...context,
      grant: testFileGrant(
        {
          kind: "draft",
          draftId: WORK_DRAFT_ID,
          owner: { kind: "work", workId: WORK_ID },
          ownerHandle: "atomicity-work",
        },
        BETA_ID,
      ),
    };
    await view.provisionDraft(BETA_ID);
    await view.collab.agentEdit().read(
      { file: "beta.md", documentId: BETA_ID },
      {
        ...betaContext,
        responseIdentity: undefined,
      },
    );
    for (const [documentId, file, ctx] of [
      [ALPHA_ID, "alpha.md", context],
      [BETA_ID, "beta.md", betaContext],
    ] as const)
      expect(
        await view.collab
          .agentEdit()
          .write(
            { command: "insert", documentId, file, content: "Agent.", tool_use_id: file },
            ctx,
          ),
      ).toMatchObject({ status: "success" });
    // BETA leaves every view; its edit rows stay.
    await treeSeeder(db).store.submit({
      lists: [await treeListOfSource(db, SOURCE_ID)],
      make: ([{ writer }]) => writer.delete(LIVE, "system", BETA_ID),
    });
    expect(await view.collab.getDocumentAndTreeChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
  } finally {
    await harness.dispose();
  }
});
