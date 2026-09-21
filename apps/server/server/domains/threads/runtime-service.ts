/** Thread runtime reads used by HTTP and WebSocket transport boundaries. */
import type { ThreadLiveState } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { eventJournal, projects, threads, threadWorks } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import type { ThreadStatusReader } from "./ports/index.js";

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
}) {
  async function requireOwnedThread(threadId: ThreadId, userId: UserId): Promise<OwnedThread> {
    const [thread] = await deps.db
      .select({
        id: threads.id,
        projectId: threads.projectId,
        workId: threadWorks.workId,
        activeLeafTurnId: threads.activeLeafTurnId,
        nextSeq: threads.nextSeq,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .leftJoin(
        threadWorks,
        and(eq(threadWorks.threadId, threads.id), eq(threadWorks.isPrimary, true)),
      )
      .where(
        and(
          eq(threads.id, threadId),
          eq(projects.userId, userId),
          isNull(threads.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);

    if (!thread) throw new HTTPError({ status: 404, message: "Thread not found" });
    return thread as OwnedThread;
  }

  async function liveState(threadId: ThreadId, userId: UserId): Promise<ThreadLiveState> {
    const thread = await requireOwnedThread(threadId, userId);
    const headSeq = thread.nextSeq;
    return {
      threadId,
      status: await deps.statusReader.read(threadId),
      runningTurnId: await deps.statusReader.readRunningTurnId(threadId),
      resumeAfterSeq: headSeq.toString(),
    };
  }

  return {
    requireOwnedThread,
    liveState,
    /** The lease-derived status seam, exposed so snapshot reads share it. */
    read: (threadId: ThreadId) => deps.statusReader.read(threadId),
    /** The lease's bound running turn, exposed so snapshot reads share one truth. */
    readRunningTurnId: (threadId: ThreadId) => deps.statusReader.readRunningTurnId(threadId),
    async journalEvents(threadId: ThreadId) {
      return deps.db.select().from(eventJournal).where(eq(eventJournal.threadId, threadId));
    },
  };
}
