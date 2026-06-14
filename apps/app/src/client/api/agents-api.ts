// @ts-nocheck
/**
 * agents-api — typed HTTP client for the global builtin agent catalog.
 *
 * Backed by `GET /api/agents` (authed, not project-scoped). Response shape
 * matches {@link ProjectAgentsResponse} from `@meridian/contracts/agents`.
 */
import type { ProjectAgentsResponse } from "@meridian/contracts/agents";

import { getJson } from "./http-client";

export const API_AGENTS_PATH = "/api/agents";

export async function listBuiltinAgents(): Promise<ProjectAgentsResponse> {
  return getJson<ProjectAgentsResponse>(API_AGENTS_PATH);
}
