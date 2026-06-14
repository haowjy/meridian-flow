// @ts-nocheck
/**
 * project-source — the single SSR/browser loader for the sidebar project list.
 *
 * Route loaders call `loadProjectList` during SSR (forwarding cookies) so the
 * shell renders the API-authoritative list on first paint; the browser falls
 * back to the same HTTP client after hydration. Owns project-list fetching.
 */
import type { Project } from "@meridian/contracts/projects";
import { listProjects } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";

/**
 * The single source of the sidebar's project list.
 *
 * Route loaders call this during SSR so the authenticated shell can render
 * the API-authoritative project list on first paint. The browser fallback
 * path uses the same HTTP client after hydration when this server fetch fails.
 */
export async function loadProjectList(): Promise<Project[]> {
  return listProjects(ssrApiRequestInit());
}
