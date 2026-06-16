/**
 * Causal turn ordering for thread snapshots and read projections.
 *
 * Turns are persisted with a `prevTurnId` linked-list edge. Snapshot rendering
 * must use that causal edge instead of wall-clock `createdAt` alone because a
 * user turn and its assistant response can legitimately share the same
 * millisecond timestamp, leaving SQL/JS timestamp tie ordering nondeterministic.
 */
import type { Turn } from "@meridian/contracts/threads";

function compareTurnFallback(a: Turn, b: Turn): number {
  const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return a.id.localeCompare(b.id);
}

/**
 * Order turns parent-before-child using each turn's `prevTurnId` edge.
 *
 * Missing parents are treated as roots so partially retained/imported histories
 * still render every turn. Cycles cannot satisfy parent-before-child; if one is
 * ever present, the remaining cyclic turns are appended by the stable fallback
 * rather than being dropped or duplicated.
 */
export function orderTurnsCausally(turns: readonly Turn[]): Turn[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const childrenByParentId = new Map<string, Turn[]>();
  const roots: Turn[] = [];

  for (const turn of turns) {
    const parentId = turn.prevTurnId ?? null;
    if (!parentId || !byId.has(parentId)) {
      roots.push(turn);
      continue;
    }

    const children = childrenByParentId.get(parentId) ?? [];
    children.push(turn);
    childrenByParentId.set(parentId, children);
  }

  roots.sort(compareTurnFallback);
  for (const children of childrenByParentId.values()) {
    children.sort(compareTurnFallback);
  }

  const ordered: Turn[] = [];
  const emitted = new Set<string>();
  const queue = [...roots];

  for (let index = 0; index < queue.length; index += 1) {
    const turn = queue[index];
    if (!turn || emitted.has(turn.id)) continue;

    emitted.add(turn.id);
    ordered.push(turn);
    queue.push(...(childrenByParentId.get(turn.id) ?? []));
  }

  if (ordered.length === turns.length) return ordered;

  const cyclicOrDisconnected = turns
    .filter((turn) => !emitted.has(turn.id))
    .sort(compareTurnFallback);
  return [...ordered, ...cyclicOrDisconnected];
}
