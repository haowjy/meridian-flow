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
import type {
  ExecutionReportRepository,
  LatestChildExecution,
  ThreadChild,
  ThreadRepository,
  ThreadStatusReader,
} from "../ports/index.js";

/** Pure projection of child rows, admitted executions, and batch lease state. */
export function projectThreadActivity(
  children: readonly ThreadChild[],
  leases: ReadonlyMap<ThreadId, ThreadLeaseState>,
  latestRuns: ReadonlyMap<ThreadId, LatestChildExecution>,
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
        deliveryMode: deliveryMode(latestRuns.get(child.id as ThreadId)),
        runStartedAt: latestRuns.get(child.id as ThreadId)?.admittedAt ?? null,
        runEndedAt: latestRuns.get(child.id as ThreadId)?.terminalAt ?? null,
        currentTool:
          leases.get(child.id as ThreadId)?.status.kind === "awake"
            ? (leases.get(child.id as ThreadId)?.currentTool ?? null)
            : null,
        originTurnId: child.originTurnId ?? null,
      }),
    ),
  };
}

export type ThreadActivityReadDeps = {
  threads: Pick<ThreadRepository, "listChildren">;
  statusReader: Pick<ThreadStatusReader, "readMany">;
  executionReports: Pick<ExecutionReportRepository, "listLatestByChildren">;
};

/** Read `threadId`'s direct-child activity + one batched lease read. */
export async function readThreadActivity(
  deps: ThreadActivityReadDeps,
  threadId: ThreadId,
): Promise<ThreadActivity> {
  const children = await deps.threads.listChildren(threadId);
  const childIds = children.map((child) => child.id as ThreadId);
  const [leases, runs] = await Promise.all([
    deps.statusReader.readMany(childIds),
    deps.executionReports.listLatestByChildren(childIds),
  ]);
  return projectThreadActivity(
    children,
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
