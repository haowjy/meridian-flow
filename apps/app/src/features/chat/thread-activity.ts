/**
 * Pure helpers for the running-subagents surface: re-base a run-tree activity
 * onto one viewed thread and select live nodes.
 *
 * No transport or React here — the live wiring lives in `useThreadActivity`,
 * so this logic is directly unit-testable.
 */
import type { ThreadActivity, ThreadActivityNode } from "@meridian/contracts/threads";

export const EMPTY_THREAD_ACTIVITY: ThreadActivity = { descendants: [] };

export function isThreadActivity(value: unknown): value is ThreadActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as ThreadActivity).descendants);
}

/**
 * Re-base a full run-tree activity onto one viewed thread.
 *
 * A live `subagent.activity` frame carries the ROOT's subtree, so a non-root
 * view must filter to nodes whose ancestry reaches the viewed thread; the
 * source order (depth, createdAt) is preserved.
 */
export function subtreeOf(activity: ThreadActivity, viewedThreadId: string): ThreadActivity {
  const parentById = new Map(
    activity.descendants.map((node) => [node.threadId, node.parentThreadId]),
  );
  return {
    descendants: activity.descendants.filter((node) => {
      let parent = node.parentThreadId;
      while (parent) {
        if (parent === viewedThreadId) return true;
        parent = parentById.get(parent) ?? null;
      }
      return false;
    }),
  };
}

/**
 * A node the strip shows: its lease is live. The durable `spawnStatus` cannot
 * stand in — a settled child whose process died leaves `spawnStatus: "running"`
 * with no lease, and the row already reads `Asleep`; trusting the lease keeps
 * the header count and the per-node status in agreement.
 */
export function isActiveNode(node: ThreadActivityNode): boolean {
  return node.status.kind === "awake";
}

export function activeDescendants(activity: ThreadActivity): ThreadActivityNode[] {
  return activity.descendants.filter(isActiveNode);
}
