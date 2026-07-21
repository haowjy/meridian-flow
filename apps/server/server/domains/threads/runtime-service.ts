/** Thread runtime reads used by HTTP and WebSocket transport boundaries. */
import type { ThreadLiveState } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { eventJournal, projects, threads, threadWorks } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";

export type ThreadRuntimeService = ReturnType<typeof createThreadRuntimeService>;

type OwnedThread = {
  id: ThreadId;
  projectId: ProjectId;
  workId: WorkId;
  currentAgentId: string | null;
  activeLeafTurnId: TurnId | null;
  nextSeq: bigint;
  status: string;
};

export function createThreadRuntimeService(deps: { db: Database }) {
  async function requireOwnedThread(threadId: ThreadId, userId: UserId): Promise<OwnedThread> {
    const [thread] = await deps.db
      .select({
        id: threads.id,
        projectId: threads.projectId,
        workId: threadWorks.workId,
        currentAgentId: threads.currentAgentId,
        activeLeafTurnId: threads.activeLeafTurnId,
        nextSeq: threads.nextSeq,
        status: threads.status,
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

    if (!thread?.workId) throw new HTTPError({ status: 404, message: "Thread not found" });
    return thread as OwnedThread;
  }

  async function liveState(threadId: ThreadId, userId: UserId): Promise<ThreadLiveState> {
    const thread = await requireOwnedThread(threadId, userId);
    const headSeq = thread.nextSeq;
    return {
      threadId,
      status: thread.status === "archived" ? "archived" : "idle",
      runningTurnId: null,
      currentAgent: thread.currentAgentId,
      nextSeq: (headSeq + 1n).toString(),
      resumeAfterSeq: headSeq.toString(),
    };
  }

  return {
    requireOwnedThread,
    liveState,
    async journalEvents(threadId: ThreadId) {
      return deps.db.select().from(eventJournal).where(eq(eventJournal.threadId, threadId));
    },
  };
}
