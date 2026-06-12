// @ts-nocheck
/**
 * merge-api-workbenches — merges an authoritative API workbench list with optimistic
 * rows not yet in the response (and excludes soft-deleted rows pending finalize).
 * Pure reconcile helper for the workbench list cache/store.
 */
import type { Workbench } from "@meridian/contracts/workbenches";

/**
 * Merge an API workbench list with any optimistic rows not yet in the response.
 * `excludeIds` — soft-deleted rows still on the server until finalize (undo window).
 */
export function mergeApiWorkbenches(
  prev: Workbench[] | null,
  apiProjects: Workbench[],
  opts?: { excludeIds?: Iterable<string> },
): Workbench[] {
  const exclude = opts?.excludeIds ? new Set(opts.excludeIds) : null;
  const api = exclude ? apiProjects.filter((p) => !exclude.has(p.id)) : apiProjects;
  const apiIds = new Set(api.map((p) => p.id));
  const optimisticOnly = (prev ?? []).filter((p) => !apiIds.has(p.id) && !exclude?.has(p.id));
  return [...optimisticOnly, ...api];
}
