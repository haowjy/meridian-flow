/**
 * Named risk: Discard is a local edit of the draft text, so a reply still writing when the writer discards
 * lands words inside text that is gone. The reply must still commit (no refusal), the discarded text must
 * stay discarded, and the invisible write (only that one) must be reported.
 */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

/** A staged reply replacing text in both paragraphs; the writer discards the first paragraph mid-reply. */
async function replyDuringDiscard(finds: readonly string[], discardFirstParagraph: boolean) {
  const harness = createHarness(db);
  try {
    const view = harness.crossWorkProbeFixture();
    const responseId = randomUUID();
    await db.insert(schema.modelResponses).values({
      id: responseId as never,
      turnId: TURN_ID,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    await harness.seedWriterDocument("Alpha Beta.\n\nBlue sky.", responseId);
    const identity = { providerResponseId: responseId, editScopeId: responseId };
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: identity,
      grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
    };
    for (const find of finds)
      expect(
        await asGrantedWriter(() =>
          view.collab.agentEdit().write(
            {
              command: "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              find,
              content: "Gamma Delta",
              tool_use_id: find,
            },
            context,
          ),
        ),
      ).toMatchObject({ status: "success", phase: "staged" });
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.kind, "work_draft"),
          eq(schema.documentBranches.status, "active"),
        ),
      );
    if (discardFirstParagraph) {
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, branch.state);
        doc.clientID = allocateDocumentClient(doc);
        const updates = captureMutationUpdates(doc, () =>
          doc.getXmlFragment("prosemirror").delete(0, 1),
        );
        await view.branchCoordinator.commitWriterUpdate({
          branchId: branch.id,
          updateData: Y.mergeUpdates(updates),
          actorUserId: USER_ID,
          roomDocument: doc,
        });
      } finally {
        doc.destroy();
      }
    }
    const committed = await view.collab.finalizeResponseCommit(identity, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const notices = await db.select().from(schema.pendingNotices);
    const draft = await view.draftMarkdown(branch.id);
    return { committed, notices, draft };
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
}

it("a reply writing into a paragraph the writer discarded commits, reports it, and resurrects nothing", async () => {
  const { committed, notices, draft } = await replyDuringDiscard(["Beta", "sky"], true);
  expect(committed.status).toBe("committed");
  expect(draft).toBe("Blue Gamma Delta.\n");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    kind: "draft_write_invisible",
    message: expect.stringContaining("went into text the writer discarded"),
    data: { documentId: ALPHA_ID, words: 2, writeIds: [expect.any(String)] },
  });
  const invisible = (await db.select().from(schema.documentEditParts)).filter(
    (row) => row.effect.invisible,
  );
  expect(invisible).toHaveLength(1);
});

it("a reply writing only into surviving text reports nothing", async () => {
  const { notices, draft } = await replyDuringDiscard(["sky"], true);
  expect(draft).toBe("Blue Gamma Delta.\n");
  expect(notices).toEqual([]);
});
