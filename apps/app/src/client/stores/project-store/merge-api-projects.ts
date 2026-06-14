// @ts-nocheck
/**
 * merge-api-projects — merges an authoritative API project list with optimistic
 * rows not yet in the response (and excludes soft-deleted rows pending finalize).
 * Pure reconcile helper for the project list cache/store.
 */
import type { Project } from "@meridian/contracts/projects";

/**
 * Merge an API project list with any optimistic rows not yet in the response.
 * `excludeIds` — soft-deleted rows still on the server until finalize (undo window).
 */
export function mergeApiProjects(
  prev: Project[] | null,
  apiProjects: Project[],
  opts?: { excludeIds?: Iterable<string> },
): Project[] {
  const exclude = opts?.excludeIds ? new Set(opts.excludeIds) : null;
  const api = exclude ? apiProjects.filter((p) => !exclude.has(p.id)) : apiProjects;
  const apiIds = new Set(api.map((p) => p.id));
  const optimisticOnly = (prev ?? []).filter((p) => !apiIds.has(p.id) && !exclude?.has(p.id));
  return [...optimisticOnly, ...api];
}
