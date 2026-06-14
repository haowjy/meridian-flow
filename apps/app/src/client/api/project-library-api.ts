// @ts-nocheck
/**
 * project-library-api — typed HTTP client for the project Library inventory.
 *
 * Backed by `GET /api/projects/:projectId/library`. Response shapes come
 * from `@meridian/contracts/agents` so list and detail surfaces share one wire
 * contract with the server library route. Uses the shared `getJson` so the
 * transport envelope is unwrapped like every other API client — a hand-rolled
 * fetch here once returned the raw envelope and crashed the Library screen.
 */
import type { ProjectLibraryResponse } from "@meridian/contracts/agents";

import { getJson } from "./http-client";

export function projectLibraryPath(projectId: string): string {
  return `/api/projects/${projectId}/library`;
}

/** Fetch the project capability inventory (agents, skills, packages). */
export async function getProjectLibrary(projectId: string): Promise<ProjectLibraryResponse> {
  return getJson<ProjectLibraryResponse>(projectLibraryPath(projectId));
}
