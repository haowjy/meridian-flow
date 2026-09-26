/**
 * Thread activity read: "what subagents are running in this thread" as a pure
 * projection over durable rows (descendant walk) plus live leases (batch status
 * read). Never persisted as a turn block; the same read feeds the HTTP snapshot
 * and the WS `subscribed` live state, and the recomputed subtree rides the
 * `subagent.activity` event.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  ThreadActivity,
  ThreadActivityNode,
  ThreadLeaseState,
} from "@meridian/contracts/threads";
import type { ThreadDescendant, ThreadRepository, ThreadStatusReader } from "../ports/index.js";

/** Pure projection of a descendant walk + batch lease read into the activity read model. */
export function projectThreadActivity(
  descendants: readonly ThreadDescendant[],
  leases: ReadonlyMap<ThreadId, ThreadLeaseState>,
): ThreadActivity {
  return {
    descendants: descendants.map(
      (descendant): ThreadActivityNode => ({
        threadId: descendant.id,
        parentThreadId: descendant.parentThreadId,
        rootThreadId: descendant.rootThreadId,
        depth: descendant.spawnDepth,
        ref: descendant.ref,
        title: descendant.title,
        agentName: descendant.agentName,
        spawnStatus: descendant.spawnStatus,
        status: leases.get(descendant.id as ThreadId)?.status ?? { kind: "asleep" },
        originTurnId: descendant.originTurnId ?? null,
      }),
    ),
  };
}

export type ThreadActivityReadDeps = {
  threads: Pick<ThreadRepository, "listDescendants">;
  statusReader: Pick<ThreadStatusReader, "readMany">;
};

/** Read `threadId`'s own subtree activity: one descendant walk + one batched lease read. */
export async function readThreadActivity(
  deps: ThreadActivityReadDeps,
  threadId: ThreadId,
): Promise<ThreadActivity> {
  const descendants = await deps.threads.listDescendants(threadId);
  const leases = await deps.statusReader.readMany(
    descendants.map((descendant) => descendant.id as ThreadId),
  );
  return projectThreadActivity(descendants, leases);
}
