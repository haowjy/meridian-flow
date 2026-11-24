import type { ThreadActivity, ThreadActivityNode } from "@meridian/contracts/threads";

export const EMPTY_THREAD_ACTIVITY: ThreadActivity = { children: [] };

export function isThreadActivity(value: unknown): value is ThreadActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as ThreadActivity).children);
}

// keep: Liveness is the live lease (status.kind === 'awake'), not durable spawnStatus; a dead process can keep spawnStatus 'running' with no lease.
export function isActiveNode(node: ThreadActivityNode): boolean {
  return node.status.kind === "awake";
}

export function activeChildren(activity: ThreadActivity): ThreadActivityNode[] {
  return activity.children.filter(isActiveNode);
}
