/**
 * The owner join of the attribution read: a subagent's write belongs to the conversation that launched
 * it, however deep the subagent nests, and its link reveals the outermost spawn row in that conversation
 * with the spawning tool call. A primary thread's own write is its own owner.
 */
import { afterAll, beforeEach, expect, it } from "vitest";
import { createDrizzleDraftAttributionStore } from "./adapters/drizzle-document-edits.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/change-trail-postgres-harness.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

const CHILD = "00000000-0000-4000-8000-0000000008a1";
const GRANDCHILD = "00000000-0000-4000-8000-0000000008a2";
const CHILD_TURN = "00000000-0000-4000-8000-0000000008b1";
const GRANDCHILD_TURN = "00000000-0000-4000-8000-0000000008b2";
const BRANCH = "branch-1";

async function subagent(id: string, parent: string, parentTurn: string, title: string) {
  await db.insert(schema.threads).values({
    id: id as never,
    rootThreadId: THREAD_ID,
    parentThreadId: parent as never,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title,
    kind: "subagent",
    originType: "spawn",
    originTurnId: parentTurn as never,
    spawnStatus: "running",
  });
}
const turnOf = (id: string, threadId: string) =>
  db.insert(schema.turns).values({
    id: id as never,
    threadId: threadId as never,
    position: 1,
    role: "assistant",
    origin: "assistant",
    status: "complete",
  });
const spawnReport = (
  child: string,
  turn: string,
  caller: string,
  callerTurn: string,
  call: string,
) =>
  db.insert(schema.threadExecutionReports).values({
    executionTurnId: turn as never,
    childThreadId: child as never,
    handle: child.slice(-2),
    origin: "spawn",
    deliveryMode: "background_notification",
    callerThreadId: caller as never,
    callerTurnId: callerTurn as never,
    toolCallId: call,
  });
async function write(threadId: string, turnId: string, clock: number) {
  const [edit] = await db
    .insert(schema.documentEdits)
    .values({
      documentId: ALPHA_ID,
      threadId: threadId as never,
      turnId: turnId as never,
      actor: "agent",
      kind: "write",
    })
    .returning({ id: schema.documentEdits.id });
  await db.insert(schema.documentEditParts).values({
    editId: edit.id,
    ordinal: 0,
    update: Buffer.alloc(0),
    effect: { inserted: [{ client: 7, clock, len: 2 }], deleted: [] },
    frontier: {},
    origin: { kind: "pending", branchId: BRANCH, rowId: 0 },
    placement: { kind: "pending", branchId: BRANCH, rowId: 0 },
  });
}

it("a subagent of a subagent rolls up to the primary conversation and reveals the outermost spawn row", async () => {
  await subagent(CHILD, THREAD_ID, TURN_ID, "Research the lore");
  await turnOf(CHILD_TURN, CHILD);
  await subagent(GRANDCHILD, CHILD, CHILD_TURN, "Check the dates");
  await turnOf(GRANDCHILD_TURN, GRANDCHILD);
  await spawnReport(CHILD, CHILD_TURN, THREAD_ID, TURN_ID, "spawn-call-1");
  await spawnReport(GRANDCHILD, GRANDCHILD_TURN, CHILD, CHILD_TURN, "spawn-call-2");
  await write(THREAD_ID, TURN_ID, 0);
  await write(GRANDCHILD, GRANDCHILD_TURN, 2);

  const edits = await createDrizzleDraftAttributionStore(db).pendingAgentEdits(BRANCH);

  const byThread = new Map(edits.map((edit) => [edit.threadId, edit]));
  expect(byThread.get(THREAD_ID)?.owner).toEqual({
    threadId: THREAD_ID,
    title: "Thread",
    reveal: { threadId: THREAD_ID, turnId: TURN_ID },
  });
  const nested = byThread.get(GRANDCHILD);
  expect(nested?.title).toBe("Check the dates");
  expect(nested?.owner).toEqual({
    threadId: THREAD_ID,
    title: "Thread",
    reveal: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      toolCallId: "spawn-call-1",
      subagentThreadId: CHILD,
    },
  });
});
