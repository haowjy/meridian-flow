/**
 * dashboard-data — derives the project workspace's dashboard datasets from a
 * single threads + works read.
 *
 * Owns thread grouping (primary threads under work items, date buckets,
 * subagents nested under parents) plus the interrupts and activity feeds
 * derived from the same fetch. Exposes `useProjectThreadGroups` (grouping only,
 * for the thread list / chat dock) and `useProjectDashboard` (full set, for
 * project home) so the grouping pass is shared rather than recomputed per view.
 *
 * Threads come through as `ThreadListItem[]` so each row carries the
 * denormalized work + lifecycle (`attention`, `runningTurnId`) projection
 * the workspace UI renders against.
 */
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { useProjectStore } from "@/client/stores";

import { type LifecycleState, lifecycleFor } from "../lifecycle";
import { relativeTime } from "../relative-time";

/* ── Types ────────────────────────────────────────────────────────── */

export type WorkItem = {
  id: string;
  name: string;
  threadIds: string[];
  completedCount: number;
  totalCount: number;
};

export type Interrupt = {
  id: string;
  threadId: string;
  threadTitle: string;
  question: string;
  parentThreadId?: string;
  parentThreadTitle?: string;
};

export type ActivityEntry = {
  id: string;
  at: string; // human relative — "2h", "1d"
  text: string;
  tone: "neutral" | "running" | "completed" | "attention";
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

export type ProjectDashboard = ProjectThreadGroups & {
  interrupts: Interrupt[];
  activity: ActivityEntry[];
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
 * This is the single source of grouping for the project dashboard — interrupts
 * and activity are derived from the same fetch by {@link useProjectDashboard},
 * so the grouping pass runs once regardless of how many views consume it.
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

  const countSubagents = (id: string): number => subagentsByParent.get(id)?.length ?? 0;
  const isDone = (t: ThreadListItem): boolean =>
    lifecycleFor(t) === "completed" || lifecycleFor(t) === "idle";

  const grouped = new Set<string>();
  const workItems: WorkItem[] = [];
  if (works !== null) {
    for (const work of works) {
      const slice = primaryThreads.filter((t) => t.workId === work.id);
      if (slice.length === 0) continue;
      for (const t of slice) grouped.add(t.id);
      const total = slice.reduce((acc, t) => acc + 1 + countSubagents(t.id), 0);
      const completed = slice.reduce((acc, t) => {
        const childCompleted = (subagentsByParent.get(t.id) ?? []).filter(isDone).length;
        return acc + (isDone(t) ? 1 : 0) + childCompleted;
      }, 0);
      workItems.push({
        id: work.id,
        name: work.title.trim() || "Untitled Work",
        threadIds: slice.map((t) => t.id),
        completedCount: completed,
        totalCount: total,
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

/* ── Project dashboard (deep hook) ─────────────────────────────────── */

/**
 * The full project-home dataset from a single threads + works read: thread
 * groups, interrupts, and the activity feed. Built on top of
 * {@link useProjectThreadGroups} so the grouping pass is shared rather than
 * recomputed per derived view.
 *
 * Use this from the home dashboard. Views that only need the grouping (the
 * thread list, the chat dock) should call {@link useProjectThreadGroups}
 * directly so they don't re-render on the activity clock tick.
 */
export function useProjectDashboard(projectId: string): ProjectDashboard {
  const groups = useProjectThreadGroups(projectId);
  const { threads, threadById } = groups;
  const now = useProjectStore((s) => s.now);

  const interrupts = useMemo(() => deriveInterrupts(threads, threadById), [threads, threadById]);
  const activity = useMemo(() => deriveActivity(threads, now), [threads, now]);

  return { ...groups, interrupts, activity };
}

/* ── Interrupts (real data) ───────────────────────────────────────── */

/**
 * A blocked thread is a real interrupt signal. The question text isn't yet
 * surfaced by the orchestrator, so we show a generic prompt until it is.
 */
function deriveInterrupts(
  threads: ThreadListItem[],
  threadById: Map<string, ThreadListItem>,
): Interrupt[] {
  const interrupts: Interrupt[] = [];
  for (const thread of threads) {
    if (thread.status !== "blocked") continue;
    const title = thread.title?.trim() || "Untitled thread";
    const parent = thread.parentThreadId ? threadById.get(thread.parentThreadId) : undefined;
    interrupts.push({
      id: `cp-${thread.id}`,
      threadId: thread.id,
      threadTitle: title,
      question: "Needs your input to continue.",
      parentThreadId: parent?.id,
      parentThreadTitle: parent?.title ?? undefined,
    });
  }
  return interrupts;
}

/* ── Activity timeline (real data) ─────────────────────────────────── */

/**
 * Derive a recent-activity feed from real threads, newest first, using each
 * thread's `updatedAt` and current lifecycle state. There's no event log yet,
 * so this reflects current state rather than a true transition history.
 */
function deriveActivity(threads: ThreadListItem[], nowMs: number): ActivityEntry[] {
  return [...threads]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6)
    .map((t) => {
      const lifecycle = lifecycleFor(t);
      return {
        id: `act-${t.id}`,
        at: relativeTime(t.updatedAt, nowMs),
        text: `${t.title?.trim() || "Untitled thread"} ${activityVerb(lifecycle)}`,
        tone: activityTone(lifecycle),
      };
    });
}

function activityVerb(state: LifecycleState): string {
  switch (state) {
    case "executing":
      return "executing";
    case "grilling":
      return "grilling";
    case "waiting":
      return "waiting for you";
    case "interrupt":
      return "needs review";
    case "errored":
      return "hit an error";
    case "completed":
      return "completed";
    case "idle":
      return "idle";
  }
}

function activityTone(state: LifecycleState): ActivityEntry["tone"] {
  switch (state) {
    case "completed":
      return "completed";
    case "waiting":
    case "interrupt":
    case "errored":
      return "attention";
    case "executing":
    case "grilling":
      return "running";
    case "idle":
      return "neutral";
  }
}
