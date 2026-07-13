/**
 * chats-overview — the data model behind the Home destination's Chats table.
 *
 * The table is intentionally driven off ONE flat, typed row model (`ChatRow`)
 * so it stays easy to sort, filter, and rework: filters are predicates over a
 * row, sorts are comparators over a row, and columns (defined in the view) read
 * named fields. Adding a column, a filter, or a sort key is a one-line edit
 * against this model — never a JSX rewrite.
 *
 * `ChatRow` flattens a primary thread (`ThreadListItem`) joined to its `Work`
 * label, with the lifecycle pre-derived and `updatedAt` carried both as the raw
 * ISO (for relative display) and as `updatedAtMs` (for stable numeric sorting).
 *
 * Vocab: rows are **Chats** (user-facing name for primary threads), grouped by
 * **Work**. "Session" is not part of the runtime vocabulary.
 */
import type { ThreadAttention, ThreadListItem, Work } from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useWorks } from "@/client/query/useWorks";

import { useProjectThreadGroups } from "../data/dashboard-data";
import { type LifecycleState, lifecycleFor } from "../lifecycle";

/* ── Row model ─────────────────────────────────────────────────────── */

/** One flattened, sortable Chat row: a primary thread joined to its Work. */
export type ChatRow = {
  id: string;
  title: string;
  workId: string | null;
  /** Human Work label, or `null` when the chat isn't grouped under a Work. */
  workLabel: string | null;
  lifecycle: LifecycleState;
  attention: ThreadAttention;
  /** Raw ISO timestamp — for relative-time display. */
  updatedAt: string;
  /** Parsed epoch ms — the stable numeric key sorts compare on. */
  updatedAtMs: number;
};

function toChatRow(thread: ThreadListItem, workLabelById: Map<string, string>): ChatRow {
  const parsed = Date.parse(thread.updatedAt);
  return {
    id: thread.id,
    title: thread.title?.trim() || "",
    workId: thread.workId,
    workLabel: thread.workId ? (workLabelById.get(thread.workId) ?? null) : null,
    lifecycle: lifecycleFor(thread),
    attention: thread.attention,
    updatedAt: thread.updatedAt,
    updatedAtMs: Number.isNaN(parsed) ? 0 : parsed,
  };
}

/* ── Derivation hook ───────────────────────────────────────────────── */

export type ChatsOverview = {
  rows: ChatRow[];
  /** True work count (includes Works with zero chats — for the stat strip). */
  workCount: number;
  loaded: boolean;
};

/**
 * Flatten a project's primary threads into `ChatRow[]`, joined to Work labels.
 *
 * The Work label map is built from `useWorks` (the complete Work set) rather
 * than the dashboard's grouped works, which drop empty Works — that also gives
 * the honest `workCount` for the stat strip.
 */
export function useChatsOverview(projectId: string): ChatsOverview {
  const { primaryThreads, threadsLoaded } = useProjectThreadGroups(projectId);
  const { works } = useWorks(projectId);

  return useMemo(() => {
    const workLabelById = new Map<string, string>((works ?? []).map((w: Work) => [w.id, w.title]));
    return {
      rows: primaryThreads.map((thread) => toChatRow(thread, workLabelById)),
      workCount: works?.length ?? 0,
      loaded: threadsLoaded,
    };
  }, [primaryThreads, works, threadsLoaded]);
}

/* ── Filters (predicates over a row) ───────────────────────────────── */

export type ChatFilterKey = "all" | "running" | "waiting" | "errored" | "idle";

// TODO(archive-delete): make archive + delete "both real" (product decision).
// Frontend half of the work anchored here + in HomeScreen rows:
//   - add an "Archived" filter/view and exclude archived chats from the default
//     row set (pairs with the server-side list exclusion — see ThreadRepository).
//   - add per-row archive + delete (trash) actions on the Home table rows, wired
//     to the new mutations.
/** Declarative filter set — add/remove a chip by editing this array. */
export const CHAT_FILTERS: ReadonlyArray<{
  key: ChatFilterKey;
  label: string;
  match: (row: ChatRow) => boolean;
}> = [
  { key: "all", label: "All", match: () => true },
  { key: "running", label: "Running", match: (r) => r.lifecycle === "executing" },
  { key: "waiting", label: "Waiting on you", match: (r) => r.attention !== "none" },
  { key: "errored", label: "Errored", match: (r) => r.lifecycle === "errored" },
  {
    key: "idle",
    label: "Idle",
    match: (r) =>
      r.lifecycle !== "executing" && r.lifecycle !== "errored" && r.attention === "none",
  },
];

/* ── Sorts (comparators over a row) ────────────────────────────────── */

export type ChatSortKey = "updated" | "title" | "work" | "status";

/** Stable rank for status sorting: most-active first. */
const LIFECYCLE_RANK: Record<LifecycleState, number> = {
  executing: 0,
  grilling: 1,
  waiting: 2,
  errored: 3,
  interrupt: 4,
  completed: 5,
  idle: 6,
};

/**
 * Declarative sort set — each comparator returns ascending order; the table
 * applies direction. Add a sortable column by adding a comparator here.
 */
export const CHAT_SORTS: Record<ChatSortKey, (a: ChatRow, b: ChatRow) => number> = {
  updated: (a, b) => a.updatedAtMs - b.updatedAtMs,
  title: (a, b) => a.title.localeCompare(b.title),
  work: (a, b) => (a.workLabel ?? "").localeCompare(b.workLabel ?? ""),
  status: (a, b) => LIFECYCLE_RANK[a.lifecycle] - LIFECYCLE_RANK[b.lifecycle],
};

export type SortDirection = "asc" | "desc";

/** Apply a filter then a sort to produce the rendered row set. */
export function selectChatRows(
  rows: ChatRow[],
  filterKey: ChatFilterKey,
  sortKey: ChatSortKey,
  direction: SortDirection,
): ChatRow[] {
  const filter = CHAT_FILTERS.find((f) => f.key === filterKey) ?? CHAT_FILTERS[0];
  const compare = CHAT_SORTS[sortKey];
  const sign = direction === "asc" ? 1 : -1;
  return rows.filter(filter.match).sort((a, b) => sign * compare(a, b));
}
