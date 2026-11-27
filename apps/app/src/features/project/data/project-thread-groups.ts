import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";

export type WorkItem = {
  id: string;
  name: string;
  threadIds: string[];
};

export type ProjectThreadGroups = {
  workItems: WorkItem[];
  threads: ThreadListItem[];
  threadsLoaded: boolean;
  primaryThreads: ThreadListItem[];
  ungroupedThreads: ThreadListItem[];
  threadById: Map<string, ThreadListItem>;
};

export function groupProjectThreads(
  realThreads: ThreadListItem[] | null,
  works: Work[] | null,
  nameOf: (work: Work) => string,
): ProjectThreadGroups {
  const baseThreads: ThreadListItem[] = realThreads ?? [];

  const primaryThreads: ThreadListItem[] = [];
  const threadById = new Map<string, ThreadListItem>();

  for (const thread of baseThreads) {
    threadById.set(thread.id, thread);
    if (thread.kind === "primary") primaryThreads.push(thread);
  }

  const grouped = new Set<string>();
  const workItems: WorkItem[] = [];
  if (works !== null) {
    for (const work of works) {
      const slice = primaryThreads.filter((t) => t.workId === work.id);
      if (slice.length === 0) continue;
      for (const t of slice) grouped.add(t.id);
      workItems.push({
        id: work.id,
        name: work.name.trim() ? nameOf(work) : "Untitled Work",
        threadIds: slice.map((t) => t.id),
      });
    }
  }

  const ungroupedThreads = works === null ? [] : primaryThreads.filter((t) => !grouped.has(t.id));

  return {
    workItems,
    threads: baseThreads,
    threadsLoaded: realThreads !== null,
    primaryThreads,
    ungroupedThreads,
    threadById,
  };
}

export function useProjectThreadGroups(projectId: string): ProjectThreadGroups {
  const { threads: realThreads } = useProjectThreads(projectId);
  const { works, nameOf } = useWorks(projectId);

  return useMemo(
    () => groupProjectThreads(realThreads, works, nameOf),
    [realThreads, works, nameOf],
  );
}
