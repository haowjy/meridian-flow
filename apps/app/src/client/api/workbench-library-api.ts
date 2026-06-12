// @ts-nocheck
/**
 * workbench-library-api — typed HTTP client for the workbench Library inventory.
 *
 * Backed by `GET /api/workbenches/:workbenchId/library`. Response shapes come
 * from `@meridian/contracts/agents` so list and detail surfaces share one wire
 * contract with the server library route. Uses the shared `getJson` so the
 * transport envelope is unwrapped like every other API client — a hand-rolled
 * fetch here once returned the raw envelope and crashed the Library screen.
 */
import type { WorkbenchLibraryResponse } from "@meridian/contracts/agents";

import { getJson } from "./http-client";

export function workbenchLibraryPath(workbenchId: string): string {
  return `/api/workbenches/${workbenchId}/library`;
}

/** Fetch the workbench capability inventory (agents, skills, packages). */
export async function getWorkbenchLibrary(workbenchId: string): Promise<WorkbenchLibraryResponse> {
  return getJson<WorkbenchLibraryResponse>(workbenchLibraryPath(workbenchId));
}
