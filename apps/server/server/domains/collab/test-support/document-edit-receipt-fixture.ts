// Durable draft receipts and staged response setup shared by the Postgres suites.

import { randomUUID } from "node:crypto";
import { editHandle } from "@meridian/agent-edit/integration";
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
import { fencedSelection, testEnvelope } from "./draft-review-requests.js";

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
  const documentDraft = await fixture.draftStore.resolveWorkDraftForThread(ALPHA_ID, THREAD_ID);
  const draftId = documentDraft.draftId;
  const rows = await db
    .select()
    .from(schema.draftWriteJournal)
    .where(eq(schema.draftWriteJournal.draftId, draftId))
    .orderBy(schema.draftWriteJournal.id);
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
  expect(identities).toEqual(edits.map((edit) => editHandle(edit.wId as number)));
  expect(new Set(identities).size).toBe(writes.length);
  expect(rows.map((row) => editHandle(row.wId as number))).toEqual(identities);
  return { fixture, draftId, rows, responseId };
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
    grant: inProject(
      testFileGrant({ kind: "draft", workId: WORK_ID, workHandle: "atomicity-work" }),
    ),
  };
}

/** The grant names this project and its owner, as the file policy would, so a write can make a draft. */
export function inProject<T extends ReturnType<typeof testFileGrant>>(grant: T): T {
  return {
    ...grant,
    principal: { ...grant.principal, accountId: USER_ID },
    facts: { ...grant.facts, projectId: PROJECT_ID, ownerAccountId: USER_ID },
  } as T;
}
export async function setupResponseDraft(
  db: ReturnType<typeof createTestDatabase>,
  harness: ReturnType<typeof createHarness>,
  empty = false,
) {
  const { fixture, draftId, rows } = await stageDraft(
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
  const resolved = await fixture.collab.draftReview.resolveItemByDocument({
    workId: WORK_ID,
    documentId: ALPHA_ID,
  });
  if (!resolved) throw new Error("staged draft has no review item");
  const target = { workId: WORK_ID, itemKey: resolved.itemKey };
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
  return { fixture, draftId, rows, target, review, responseId, context, read, write };
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
  const operationIds = [op.operationId];
  const selection = fencedSelection(preview, operationIds);
  const envelope = testEnvelope({
    workId: target.workId,
    kind: apply ? "apply_changes" : "discard_changes",
    branchId: preview.branchId,
  });
  const outcome = await (apply
    ? fixture.collab.draftReview.applyChanges({
        ...target,
        userId: USER_ID as never,
        envelope,
        selection: { kind: "apply", ...selection },
      })
    : fixture.collab.draftReview.discardChanges({
        ...target,
        userId: USER_ID as never,
        envelope,
        selection: { kind: "discard", ...selection },
      }));
  expect(outcome.kind === "result" ? outcome.result : outcome).toMatchObject({
    status: apply ? "applied" : "discarded",
  });
}
