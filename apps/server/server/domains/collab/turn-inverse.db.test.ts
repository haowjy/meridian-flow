/** Card partial inverses and writer text preservation. */
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createTestDocumentRemoval } from "../../test-support/document-removal.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { lockDocuments } from "../context/tree/node-rows.js";
import { createDrizzleWorkBranchPendingStore } from "./adapters/drizzle-work-branch-pending.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { draftContent } from "./test-support/draft-store-seam.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it("a tombstoned draft document with released storage does not stop another document's receipt from offering Undo", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    const betaContext = {
      ...context,
      grant: testFileGrant(
        { kind: "draft", workId: WORK_ID, workHandle: "atomicity-work" },
        BETA_ID,
      ),
    };
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
    await harness.commit(responseId);
    // What Discard of a draft-created document leaves: tombstoned row, released storage, edit rows kept.
    await runInDrizzleTransaction(db, async () => {
      await lockDocuments(db, [BETA_ID]);
      await createTestDocumentRemoval(db).remove({
        documentIds: [BETA_ID],
        reason: "discarded",
        cause: "repair",
      });
    });
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("typing inside restored text leaves Redo unavailable and does not delete the writer's word", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "",
          tool_use_id: "delete",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    const pending = createDrizzleWorkBranchPendingStore(db);
    expect(await pending.pendingThreadIds(documentDraft.id)).toEqual([]);
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    expect(await pending.pendingThreadIds(documentDraft.id)).toEqual([THREAD_ID]);
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, await draftContent(db, documentDraft.id));
      doc.clientID = allocateDocumentClient(doc);
      const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
      await view.draftCoordinator.commitWriterUpdate({
        draftId: documentDraft.id,
        updateData: Y.mergeUpdates(updates),
        actorUserId: USER_ID,
        roomDocument: doc,
      });
    } finally {
      doc.destroy();
    }
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "view_change",
      skips: [{ before: "Beta", cause: "edited_since" }],
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "expired", acceptedParts: 0 });
    expect(await view.draftMarkdown(documentDraft.id)).toBe("Alpha Be!ta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
