/** Canonical convergence and causal-read boundary for a thread's Work binding. */
import type {
  ListWorksResponse,
  ThreadListItem,
  ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import type {
  RebindThreadWorkResponse,
  WorkContextProjectionSignal,
} from "@meridian/contracts/works";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { listProjectThreads } from "@/client/api/projects-api";
import { invalidateProjectHomeFeed } from "./project-invalidation";
import {
  isProjectContextCatalogKey,
  isProjectWorkDerivedKey,
  isWorkScopedProjectContextCatalogKey,
  projectQueryKeys,
} from "./project-query-keys";
import { patchThreadInProjectCaches } from "./project-thread-cache";
import { threadQueryKeys } from "./thread-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";
import {
  refreshWorksSnapshot,
  repairWorksSnapshot,
  seedWorksSnapshot,
} from "./works-projection-acquisition";

export type ThreadWorkProjectionCursor = { seq: string; workId: string | null };

export type ThreadWorkConvergence =
  | { source: "confirmed"; projectId: string; result: RebindThreadWorkResponse }
  | { source: "projected"; seq: string; signal: WorkContextProjectionSignal }
  | {
      source: "reconciled";
      projectId: string;
      threadId: string;
      previousWorkId: string | null;
      threads: ThreadListItem[];
      catalog: ListWorksResponse;
    };

export type ThreadProjectionInvalidation = {
  threadId: string;
  projectId: string;
  refreshLists: boolean;
  workIds: ReadonlySet<string> | "all";
  contextTrees: "work-scoped" | "all";
};

const compareSeq = (left: string, right: string) => {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

export function invalidateThreadProjectionDependencies(
  client: QueryClient,
  input: ThreadProjectionInvalidation,
): void {
  const ids = input.workIds === "all" ? undefined : input.workIds;
  void client.invalidateQueries({ queryKey: threadQueryKeys.thread(input.threadId) });
  void invalidateProjectHomeFeed(client, input.projectId);
  if (input.refreshLists) {
    void client.invalidateQueries({
      queryKey: projectQueryKeys.threads(input.projectId),
      exact: true,
    });
    void repairWorksSnapshot(client, input.projectId);
  }
  void client.invalidateQueries({
    predicate: ({ queryKey }) => isProjectWorkDerivedKey(queryKey, input.projectId, ids),
  });
  void client.invalidateQueries({
    predicate: ({ queryKey }) =>
      input.contextTrees === "all"
        ? isProjectContextCatalogKey(queryKey, input.projectId)
        : isWorkScopedProjectContextCatalogKey(queryKey, input.projectId, ids),
  });
}

function patchSnapshot(client: QueryClient, threadId: string, workId: string | null): void {
  client.setQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId), (current) =>
    current ? { ...current, thread: { ...current.thread, workId } } : current,
  );
}

export function convergeThreadWorkBinding(
  client: QueryClient,
  transition: ThreadWorkConvergence,
): void {
  if (transition.source === "projected") {
    const { seq, signal } = transition;
    const cursorKey = threadQueryKeys.workProjectionCursor(signal.threadId);
    const cursor = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey);
    if (cursor && compareSeq(seq, cursor.seq) <= 0) return;
    notifyManager.batch(() => {
      const projectedWorkId = signal.scope.kind === "work" ? signal.scope.workId : null;
      client.setQueryData(cursorKey, { seq, workId: projectedWorkId });
      const catalog = client.getQueryData<ListWorksResponse>(
        projectQueryKeys.works(signal.projectId),
      );
      const work = catalog?.works.find(({ id }) => id === projectedWorkId);
      if (work) {
        patchThreadInProjectCaches(client, signal.threadId, {
          workId: work.id,
          work: { id: work.id, title: work.name },
        });
        patchSnapshot(client, signal.threadId, work.id);
      } else if (projectedWorkId === null) {
        patchThreadInProjectCaches(client, signal.threadId, { workId: null, work: null });
        patchSnapshot(client, signal.threadId, null);
      }
      invalidateThreadProjectionDependencies(client, {
        threadId: signal.threadId,
        projectId: signal.projectId,
        refreshLists: false,
        workIds: "all",
        contextTrees: "work-scoped",
      });
      convergeWorkProjection(client, { kind: "binding", projectId: signal.projectId });
    });
    return;
  }

  const projectId = transition.projectId;
  const threadId =
    transition.source === "confirmed" ? transition.result.threadId : transition.threadId;
  notifyManager.batch(() => {
    if (transition.source === "confirmed") {
      const { result } = transition;
      const afterWorkId = result.after.kind === "work" ? result.after.workId : null;
      patchThreadInProjectCaches(
        client,
        threadId,
        result.after.kind === "work"
          ? {
              workId: result.after.workId,
              work: { id: result.after.workId, title: result.after.name },
            }
          : { workId: null, work: null },
      );
      patchSnapshot(client, threadId, afterWorkId);
      invalidateThreadProjectionDependencies(client, {
        threadId,
        projectId,
        refreshLists: false,
        workIds: new Set(
          [result.before.kind === "work" ? result.before.workId : null, afterWorkId].filter(
            Boolean,
          ) as string[],
        ),
        contextTrees: "work-scoped",
      });
      convergeWorkProjection(client, { kind: "binding", projectId });
      return;
    }

    client.setQueryData(projectQueryKeys.threads(projectId), transition.threads);
    seedWorksSnapshot(client, transition.catalog);
    const row = transition.threads.find(({ id }) => id === threadId);
    patchSnapshot(client, threadId, row?.workId ?? null);
    const ids = new Set([transition.previousWorkId, row?.workId].filter(Boolean) as string[]);
    invalidateThreadProjectionDependencies(client, {
      threadId,
      projectId,
      refreshLists: false,
      workIds: ids.size ? ids : "all",
      contextTrees: "work-scoped",
    });
    convergeWorkProjection(client, { kind: "binding", projectId });
  });
}

export class ThreadWorkOutcomeUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super("The thread Work outcome could not be confirmed", { cause });
    this.name = "ThreadWorkOutcomeUnconfirmedError";
  }
}

export async function readStableThreadWorkBinding(
  client: QueryClient,
  input: { projectId: string; threadId: string; previousWorkId: string | null },
): Promise<{ threads: ThreadListItem[]; catalog: ListWorksResponse; workId: string | null }> {
  const cursorKey = threadQueryKeys.workProjectionCursor(input.threadId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
    try {
      await Promise.all([
        client.cancelQueries({ queryKey: projectQueryKeys.threads(input.projectId), exact: true }),
      ]);
      const [threads, catalog] = await Promise.all([
        listProjectThreads(input.projectId),
        refreshWorksSnapshot(client, input.projectId),
      ]);
      const after = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      if (before !== after) continue;
      convergeThreadWorkBinding(client, { source: "reconciled", ...input, threads, catalog });
      return {
        threads,
        catalog,
        workId: threads.find(({ id }) => id === input.threadId)?.workId ?? null,
      };
    } catch (cause) {
      throw new ThreadWorkOutcomeUnconfirmedError(cause);
    }
  }
  throw new ThreadWorkOutcomeUnconfirmedError();
}
