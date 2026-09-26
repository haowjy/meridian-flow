/**
 * Thread activity read: "what direct subagents are running in this thread" as a
 * pure projection over child rows plus live leases (batch status read). Never
 * persisted as a turn block; the same read feeds snapshots, WS `subscribed`
 * state, and live `subagent.activity` events.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  ThreadActivity,
  ThreadActivityNode,
  ThreadLeaseState,
} from "@meridian/contracts/threads";
import type { ThreadChild, ThreadRepository, ThreadStatusReader } from "../ports/index.js";

/** Pure projection of direct child rows + batch lease read into the activity read model. */
export function projectThreadActivity(
  children: readonly ThreadChild[],
  leases: ReadonlyMap<ThreadId, ThreadLeaseState>,
): ThreadActivity {
  return {
    children: children.map(
      (child): ThreadActivityNode => ({
        threadId: child.id,
        parentThreadId: child.parentThreadId,
        ref: child.ref,
        title: child.title,
        agentName: child.agentName,
        spawnStatus: child.spawnStatus,
        status: leases.get(child.id as ThreadId)?.status ?? { kind: "asleep" },
        originTurnId: child.originTurnId ?? null,
      }),
    ),
  };
}

export type ThreadActivityReadDeps = {
  threads: Pick<ThreadRepository, "listChildren">;
  statusReader: Pick<ThreadStatusReader, "readMany">;
};

/** Read `threadId`'s direct-child activity + one batched lease read. */
export async function readThreadActivity(
  deps: ThreadActivityReadDeps,
  threadId: ThreadId,
): Promise<ThreadActivity> {
  const children = await deps.threads.listChildren(threadId);
  const leases = await deps.statusReader.readMany(children.map((child) => child.id as ThreadId));
  return projectThreadActivity(children, leases);
}
