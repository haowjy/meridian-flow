import type { ThreadLiveState } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { RunState } from "@meridian/contracts/threads";
import { readThreadActivity } from "./domain/thread-activity.js";
import { threadAvailabilityCode } from "./domain/thread-availability.js";
import type {
  ExecutionReportRepository,
  ThreadRepository,
  ThreadStatusReader,
} from "./ports/index.js";
import { throwThreadDeleted, throwThreadNotFound } from "./thread-access.js";

export type ThreadRuntimeService = ReturnType<typeof createThreadRuntimeService>;

type OwnedThread = {
  id: ThreadId;
  projectId: ProjectId;
  workId: WorkId | null;
  activeLeafTurnId: TurnId | null;
  nextSeq: bigint;
};

export function createThreadRuntimeService(deps: {
  statusReader: ThreadStatusReader;
  threads: Pick<ThreadRepository, "listChildren" | "findByIdIncludingDeleted">;
  executionReports: Pick<ExecutionReportRepository, "listLatestByChildren">;
  readRunState: (threadId: ThreadId) => Promise<RunState>;
}) {
  async function requireOwnedThread(threadId: ThreadId, userId: UserId): Promise<OwnedThread> {
    const thread = await deps.threads.findByIdIncludingDeleted(threadId);

    const code = threadAvailabilityCode(thread, thread?.project, userId);
    if (code === "thread_deleted") throwThreadDeleted(userId, !!thread?.project?.deletedAt);
    if (code === "thread_not_found" || !thread) throwThreadNotFound(userId);
    if (thread.nextSeq === undefined) throw new Error("Thread runtime sequence is unavailable");
    return {
      id: thread.id,
      projectId: thread.projectId,
      workId: thread.workId,
      activeLeafTurnId: thread.activeLeafTurnId,
      nextSeq: BigInt(thread.nextSeq),
    };
  }

  async function liveState(threadId: ThreadId, userId: UserId): Promise<ThreadLiveState> {
    await requireOwnedThread(threadId, userId);
    return {
      threadId,
      status: await deps.statusReader.read(threadId),
      activity: await readThreadActivity(
        {
          threads: deps.threads,
          statusReader: deps.statusReader,
          executionReports: deps.executionReports,
        },
        threadId,
      ),
      runState: await deps.readRunState(threadId),
    };
  }

  return {
    requireOwnedThread,
    liveState,
    read: (threadId: ThreadId) => deps.statusReader.read(threadId),
    readMany: (threadIds: readonly ThreadId[]) => deps.statusReader.readMany(threadIds),
    readRunningTurnId: (threadId: ThreadId) => deps.statusReader.readRunningTurnId(threadId),
    readRunState: (threadId: ThreadId) => deps.readRunState(threadId),
  };
}
