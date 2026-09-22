/**
 * merge-api-projects — merges an authoritative API project list with optimistic
 * rows from the cache that the response does not yet include (independent
 * creation inserts before the server list lands). Pure reconcile helper for the
 * project list cache/store.
 */
import type { Project } from "@meridian/contracts/projects";

/**
 * Merge an API project list with any cached rows not yet in the response.
 */
export function mergeApiProjects(prev: Project[] | null, apiProjects: Project[]): Project[] {
  const apiIds = new Set(apiProjects.map((project) => project.id));
  const optimisticOnly = (prev ?? []).filter((project) => !apiIds.has(project.id));
  return [...optimisticOnly, ...apiProjects];
}
