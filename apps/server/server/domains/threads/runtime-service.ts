/** Thread runtime reads used by HTTP and WebSocket transport boundaries. */
import type { ThreadLiveState } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { RunState } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { eventJournal } from "@meridian/database";
import { eq } from "drizzle-orm";
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
  db: Database;
  /** Supplies the lease-derived run status; the runtime authority satisfies it. */
  statusReader: ThreadStatusReader;
  /** Supplies direct children for the per-thread activity read. */
  threads: Pick<ThreadRepository, "listChildren" | "findByIdIncludingDeleted">;
  /** Supplies the latest admitted execution per child. */
  executionReports: Pick<ExecutionReportRepository, "listLatestByChildren">;
  /** Reads the chat's run-state record with the journal head in one read transaction. */
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
    const thread = await requireOwnedThread(threadId, userId);
    const headSeq = thread.nextSeq;
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
      resumeAfterSeq: headSeq.toString(),
    };
  }

  return {
    requireOwnedThread,
    liveState,
    /** The lease-derived status seam, exposed so snapshot reads share it. */
    read: (threadId: ThreadId) => deps.statusReader.read(threadId),
    /** Batch status seam for list pages; same lease read as `read`. */
    readMany: (threadIds: readonly ThreadId[]) => deps.statusReader.readMany(threadIds),
    /** The lease's bound running turn, exposed so snapshot reads share one truth. */
    readRunningTurnId: (threadId: ThreadId) => deps.statusReader.readRunningTurnId(threadId),
    /** The run-state record at the journal head, so snapshot reads share one record. */
    readRunState: (threadId: ThreadId) => deps.readRunState(threadId),
    async journalEvents(threadId: ThreadId) {
      return deps.db.select().from(eventJournal).where(eq(eventJournal.threadId, threadId));
    },
  };
}
