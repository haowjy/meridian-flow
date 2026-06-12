// @ts-nocheck
/**
 * workbench-agents-api — typed HTTP client for the workbench agent catalog.
 *
 * Backed by `GET /api/workbenches/:workbenchId/agents`. Response shapes come
 * from `@meridian/contracts/agents` so picker and chip surfaces share one wire
 * contract with the server catalog route.
 */
import type { WorkbenchAgentsResponse } from "@meridian/contracts/agents";

import { getJson } from "./http-client";

export function workbenchAgentsPath(workbenchId: string): string {
  return `/api/workbenches/${workbenchId}/agents`;
}

export async function listWorkbenchAgents(workbenchId: string): Promise<WorkbenchAgentsResponse> {
  return getJson<WorkbenchAgentsResponse>(workbenchAgentsPath(workbenchId));
}
