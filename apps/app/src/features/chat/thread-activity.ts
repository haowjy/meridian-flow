/**
 * Pure helpers for the running-subagents surface: validate activity and select
 * live direct children.
 *
 * No transport or React here — the live wiring lives in `useThreadActivity`,
 * so this logic is directly unit-testable.
 */
import type { ThreadActivity, ThreadActivityNode } from "@meridian/contracts/threads";

export const EMPTY_THREAD_ACTIVITY: ThreadActivity = { children: [] };

export function isThreadActivity(value: unknown): value is ThreadActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as ThreadActivity).children);
}

/**
 * The strip shows nodes with a live lease. A settled child whose process died
 * can retain `spawnStatus: "running"` with no lease, so durable status cannot
 * stand in for liveness.
 */
export function isActiveNode(node: ThreadActivityNode): boolean {
  return node.status.kind === "awake";
}

export function activeChildren(activity: ThreadActivity): ThreadActivityNode[] {
  return activity.children.filter(isActiveNode);
}
