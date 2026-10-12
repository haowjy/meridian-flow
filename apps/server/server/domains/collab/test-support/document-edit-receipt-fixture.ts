// Durable draft receipts and staged response setup shared by the Postgres suites.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { testFileGrant } from "../../../test-support/file-grants.js";
import {
  ALPHA_ID,
  type createHarness,
  type createTestDatabase,
  PROJECT_ID,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./change-trail-postgres-harness.js";

type ReceiptFixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;

export async function stageDraft(
  db: ReturnType<typeof createTestDatabase>,
  harness: ReturnType<typeof createHarness>,
  initial: string,
  kind: "insert" | "replace",
  writes: readonly (readonly [string, string])[],
) {
  const fixture = harness.crossWorkProbeFixture();
  const responseId = await createResponse(db, 1);
  await harness.seedWriterDocument(initial, responseId);
  const context = responseContext(responseId);
  const identities = [];
  for (const [find, content] of writes) {
    const outcome = await fixture.collab.agentEdit().write(
      {
        command: kind,
        file: "alpha.md",
        documentId: ALPHA_ID,
        find,
        content,
        tool_use_id: find,
      },
      context,
    );
    expect(outcome).toMatchObject({ status: "success", phase: "staged" });
    identities.push(outcome.writeId);
  }
  expect(await harness.commit(responseId)).toMatchObject({ status: "committed" });
  const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
  const branchId = branch.branchId;
  branch.doc.destroy();
  const rows = await db
    .select()
    .from(schema.branchWriteJournal)
    .where(eq(schema.branchWriteJournal.branchId, branchId))
    .orderBy(schema.branchWriteJournal.id);
  expect(rows).toHaveLength(writes.length);
  const edits = await db
    .select()
    .from(schema.documentEdits)
    .where(
      and(
        eq(schema.documentEdits.documentId, ALPHA_ID),
        eq(schema.documentEdits.threadId, THREAD_ID),
      ),
    )
    .orderBy(schema.documentEdits.wId);
  expect(identities).toEqual(edits.map((edit) => `w${edit.wId}`));
  expect(new Set(identities).size).toBe(writes.length);
  expect(rows.map((row) => `w${row.wId}`)).toEqual(identities);
  return { fixture, branchId, rows, responseId };
}

export async function createResponse(db: ReturnType<typeof createTestDatabase>, sequence: number) {
  const responseId = randomUUID();
  await db.insert(schema.modelResponses).values({
    id: responseId as never,
    turnId: TURN_ID,
    sequence,
    provider: "mock",
    model: "mock",
    requestMessageCount: 1,
    predictedCacheState: "cold",
    predictedCacheReason: "facts_unavailable",
  });
  return responseId;
}
export function responseContext(responseId: string) {
  return {
    sessionId: THREAD_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
  };
}
export async function setupResponseDraft(
  db: ReturnType<typeof createTestDatabase>,
  harness: ReturnType<typeof createHarness>,
  empty = false,
) {
  const { fixture, branchId, rows } = await stageDraft(
    db,
    harness,
    "red\n\nblue\n\ngreen",
    "replace",
    empty
      ? [["red", "gold"]]
      : [
          ["red", "gold"],
          ["blue", "azure"],
        ],
  );
  const target = {
    projectId: PROJECT_ID as never,
    workId: WORK_ID,
    documentId: ALPHA_ID,
    draftId: branchId,
  };
  const review = (after: string, apply = false) => reviewChange(fixture, target, after, apply);
  const read = () =>
    fixture.collab
      .agentEdit()
      .read({ file: "alpha.md", documentId: ALPHA_ID, tool_use_id: `read-${++tool}` }, context);
  const responseId = await createResponse(db, 2);
  const context = responseContext(responseId);
  let tool = 0;
  const write = (find: string, content: string, command: "replace" | "insert" = "replace") =>
    fixture.collab.agentEdit().write(
      {
        command,
        file: "alpha.md",
        documentId: ALPHA_ID,
        find,
        content,
        tool_use_id: `later-${++tool}`,
      },
      context,
    );
  return { fixture, branchId, rows, target, review, responseId, context, read, write };
}
export async function reviewChange(
  fixture: ReceiptFixture,
  target: Parameters<ReceiptFixture["collab"]["draftReview"]["preview"]>[0],
  after: string,
  apply = false,
) {
  const preview = await fixture.collab.draftReview.preview(target);
  if (preview.status !== "active") throw new Error("Missing active preview");
  const op = preview.operations.find((op) => op.afterExcerpt === after);
  if (!op) throw new Error(`Missing ${after}: ${JSON.stringify(preview.operations)}`);
  const command = {
    ...target,
    userId: USER_ID as never,
    operationIds: [op.operationId],
    closureClassIds: [op.closureClassId],
    admissionTokens: [op.admissionToken],
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
  };
  expect(
    await (apply
      ? fixture.collab.draftReview.applyWorkDraftChanges(command)
      : fixture.collab.draftReview.discardWorkDraft(command)),
  ).toMatchObject({ status: apply ? "applied" : "discarded" });
}
