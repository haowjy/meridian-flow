/**
 * project-agents-api — typed HTTP client for the project agent catalog.
 *
 * Backed by `GET /api/projects/:projectId/agents`. Response shapes come
 * from `@meridian/contracts/agents` so picker and chip surfaces share one wire
 * contract with the server catalog route.
 */
import type { ProjectAgentsResponse } from "@meridian/contracts/agents";

import { getJson } from "./http-client";

export function projectAgentsPath(projectId: string): string {
  return `/api/projects/${projectId}/agents`;
}

export async function listProjectAgents(projectId: string): Promise<ProjectAgentsResponse> {
  return getJson<ProjectAgentsResponse>(projectAgentsPath(projectId));
}
