/** Seeds a second Work (with its primary chat and one assistant turn) beside the harness's first. */

import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { createHarness } from "./change-trail-postgres-harness.js";
import { PROJECT_ID, USER_ID } from "./change-trail-postgres-harness.js";

type CrossWorkProbeFixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;

export const WORK_B_ID = "00000000-0000-4000-8000-000000000820" as WorkId;
export const THREAD_B_ID = "00000000-0000-4000-8000-000000000821" as ThreadId;
export const TURN_B_ID = "00000000-0000-4000-8000-000000000822" as TurnId;

/** A second Work in the project with its own primary chat and one assistant turn. */
export async function seedSecondWork(fixture: CrossWorkProbeFixture): Promise<void> {
  const { db, schema } = fixture;
  await db
    .insert(schema.works)
    .values({
      id: WORK_B_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Work B",
      handle: "w2",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.threads)
    .values({
      rootThreadId: THREAD_B_ID,
      id: THREAD_B_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      title: "Work B primary chat",
      kind: "primary",
      status: "idle",
      aiWriteMode: "draft",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.turns)
    .values({
      id: TURN_B_ID,
      threadId: THREAD_B_ID,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.threadWorks)
    .values({
      threadId: THREAD_B_ID,
      workId: WORK_B_ID,
      projectId: PROJECT_ID,
      isPrimary: true,
    })
    .onConflictDoNothing();
}
