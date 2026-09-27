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
import type {
  ExecutionReportRepository,
  LatestChildExecution,
  ThreadDescendant,
  ThreadRepository,
  ThreadStatusReader,
} from "../ports/index.js";

/** Pure projection of child rows, admitted executions, and batch lease state. */
export function projectThreadActivity(
  descendants: readonly ThreadDescendant[],
  leases: ReadonlyMap<ThreadId, ThreadLeaseState>,
  latestRuns: ReadonlyMap<ThreadId, LatestChildExecution>,
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
        deliveryMode: deliveryMode(latestRuns.get(descendant.id as ThreadId)),
        runStartedAt: latestRuns.get(descendant.id as ThreadId)?.admittedAt ?? null,
        runEndedAt: latestRuns.get(descendant.id as ThreadId)?.terminalAt ?? null,
        currentTool:
          leases.get(descendant.id as ThreadId)?.status.kind === "awake"
            ? (leases.get(descendant.id as ThreadId)?.currentTool ?? null)
            : null,
        originTurnId: descendant.originTurnId ?? null,
      }),
    ),
  };
}

export type ThreadActivityReadDeps = {
  threads: Pick<ThreadRepository, "listDescendants">;
  statusReader: Pick<ThreadStatusReader, "readMany">;
  executionReports: Pick<ExecutionReportRepository, "listLatestByChildren">;
};

/** Read the activity subtree with batched lease and latest-admission projections. */
export async function readThreadActivity(
  deps: ThreadActivityReadDeps,
  threadId: ThreadId,
): Promise<ThreadActivity> {
  const descendants = await deps.threads.listDescendants(threadId);
  const childIds = descendants.map((descendant) => descendant.id as ThreadId);
  const [leases, runs] = await Promise.all([
    deps.statusReader.readMany(childIds),
    deps.executionReports.listLatestByChildren(childIds),
  ]);
  return projectThreadActivity(
    descendants,
    leases,
    new Map(runs.map((run) => [run.childThreadId, run])),
  );
}

function deliveryMode(run: LatestChildExecution | undefined): ThreadActivityNode["deliveryMode"] {
  if (!run) return null;
  // `none` is an admitted thread-run without a foreground invocation; its
  // writer-facing activity is necessarily background, not direct delivery.
  return run.deliveryMode === "direct" ? "direct" : "background_notification";
}
