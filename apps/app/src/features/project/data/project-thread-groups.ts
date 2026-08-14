/** Groups project threads by Work, parent, and activity date for chat navigation. */
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";

/* ── Types ────────────────────────────────────────────────────────── */

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
  subagentsByParent: Map<string, ThreadListItem[]>;
  ungroupedThreads: ThreadListItem[];
  threadById: Map<string, ThreadListItem>;
};

export type DateThreadBucketId = "today" | "yesterday" | "previous7" | "earlier";

export type DateThreadBucket = {
  id: DateThreadBucketId;
  threadIds: string[];
};

const DATE_BUCKET_IDS: readonly DateThreadBucketId[] = [
  "today",
  "yesterday",
  "previous7",
  "earlier",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/* ── Thread grouping (real data) ───────────────────────────────────── */

/**
 * Group a project's real threads under their real work items.
 *
 * Primary threads are grouped by `thread.workId` against the project's works.
 * Subagents nest under their parent thread (via `parentThreadId`). Primary
 * threads without a resolved work fall through to `ungroupedThreads` only
 * after works have loaded; while works are `null`, grouping waits.
 *
 * This is the single source of grouping for project chat navigation.
 */
export function groupProjectThreads(
  realThreads: ThreadListItem[] | null,
  works: Work[] | null,
): ProjectThreadGroups {
  const baseThreads: ThreadListItem[] = realThreads ?? [];

  const primaryThreads: ThreadListItem[] = [];
  const subagentsByParent = new Map<string, ThreadListItem[]>();
  const threadById = new Map<string, ThreadListItem>();

  for (const thread of baseThreads) {
    threadById.set(thread.id, thread);
    if (thread.kind === "primary") {
      primaryThreads.push(thread);
    } else if (thread.parentThreadId) {
      const list = subagentsByParent.get(thread.parentThreadId) ?? [];
      list.push(thread);
      subagentsByParent.set(thread.parentThreadId, list);
    }
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
        name: work.name.trim() || "Untitled Work",
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
    subagentsByParent,
    ungroupedThreads,
    threadById,
  };
}

export function useProjectThreadGroups(projectId: string): ProjectThreadGroups {
  const { threads: realThreads } = useProjectThreads(projectId);
  const { works } = useWorks(projectId);

  return useMemo(() => groupProjectThreads(realThreads, works), [realThreads, works]);
}

/**
 * Bucket primary threads by `updatedAt` recency for the sidebar's Date grouping.
 *
 * Buckets are calendar-day based in the browser's local timezone, ordered from
 * newest to oldest, and each bucket keeps newest-first thread ordering.
 */
export function groupThreadsByDate(
  threads: readonly ThreadListItem[],
  nowMs = Date.now(),
): DateThreadBucket[] {
  const buckets = new Map<DateThreadBucketId, string[]>(
    DATE_BUCKET_IDS.map((id) => [id, []] as const),
  );

  for (const thread of sortThreadsByRecency(threads)) {
    const bucket = dateBucketFor(thread.updatedAt, nowMs);
    buckets.get(bucket)?.push(thread.id);
  }

  return DATE_BUCKET_IDS.map((id) => ({ id, threadIds: buckets.get(id) ?? [] })).filter(
    (bucket) => bucket.threadIds.length > 0,
  );
}

export function sortThreadsByRecency<T extends { updatedAt: string }>(threads: readonly T[]): T[] {
  return [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function dateBucketFor(updatedAt: string, nowMs: number): DateThreadBucketId {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) return "earlier";

  const todayStart = startOfLocalDay(nowMs);
  const threadStart = startOfLocalDay(timestamp);
  const daysAgo = Math.floor((todayStart - threadStart) / DAY_MS);

  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo <= 7) return "previous7";
  return "earlier";
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
