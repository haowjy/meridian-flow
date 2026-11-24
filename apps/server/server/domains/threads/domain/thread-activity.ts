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
  return run.deliveryMode === "direct" ? "direct" : "background_notification";
}
