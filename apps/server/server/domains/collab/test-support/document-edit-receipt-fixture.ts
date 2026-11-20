// Staged model writes and response setup shared by the Postgres suites.

import { randomUUID } from "node:crypto";
import { editHandle } from "@meridian/agent-edit/integration";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { grantInProject, testFileGrant } from "../../../test-support/file-grants.js";
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
} from "./collab-postgres-harness.js";

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
    expect(outcome).toMatchObject({ status: "success", phase: "committed" });
    identities.push(outcome.writeId);
  }
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
  return { fixture, responseId };
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
    responseIdentity: { modelResponseId: responseId },
    grant: inProject(
      testFileGrant({
        kind: "draft",
        owner: { kind: "work", workId: WORK_ID },
        ownerHandle: "atomicity-work",
      }),
    ),
  };
}

/** The grant names this project and its owner, as the file policy would, so a write can make a draft. */
export function inProject<T extends ReturnType<typeof testFileGrant>>(grant: T): T {
  return grantInProject(grant, PROJECT_ID, USER_ID);
}
