// @ts-nocheck
/**
 * agents-api — typed HTTP client for the global builtin agent catalog.
 *
 * Backed by `GET /api/agents` (authed, not workbench-scoped). Response shape
 * matches {@link WorkbenchAgentsResponse} from `@meridian/contracts/agents`.
 */
import type { WorkbenchAgentsResponse } from "@meridian/contracts/agents";

import { getJson } from "./http-client";

export const API_AGENTS_PATH = "/api/agents";

export async function listBuiltinAgents(): Promise<WorkbenchAgentsResponse> {
  return getJson<WorkbenchAgentsResponse>(API_AGENTS_PATH);
}
