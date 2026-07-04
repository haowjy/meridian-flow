/**
 * Project preferences route core: parses the locked preference PUT body and applies project ownership before reading or writing preferences.
 * Kept beside routes so HTTP handlers stay thin while tests can exercise authz-independent route behavior without booting Nitro.
 */
import {
  type ProjectPreferencesResponse,
  THREAD_GROUP_BY_VALUES,
  type ThreadGroupBy,
  type UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import { createError } from "nitro/h3";
import { listProjectCatalogAgents } from "../domains/packages/domain/agent-catalog.js";
import type { PackageRepository } from "../domains/packages/index.js";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectPreferencesRouteDeps {
  projectRepo: ProjectRepository;
  preferences: ProjectPreferencesRepository;
  packageRepository: PackageRepository;
}

export interface ProjectPreferencesRouteInput {
  projectId: string;
  userId: string;
}

function isThreadGroupBy(value: unknown): value is ThreadGroupBy {
  return (THREAD_GROUP_BY_VALUES as readonly string[]).includes(String(value));
}

export function parseUpdateProjectPreferencesRequest(
  raw: unknown,
): UpdateProjectPreferencesRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }

  const body = raw as Record<string, unknown>;
  const parsed: UpdateProjectPreferencesRequest = {};

  if (body.threadGroupBy !== undefined) {
    if (!isThreadGroupBy(body.threadGroupBy)) {
      throw createError({
        statusCode: 400,
        message: "`threadGroupBy` must be 'work', 'date', or 'flat'",
      });
    }
    parsed.threadGroupBy = body.threadGroupBy;
  }

  if (body.pinnedThreadIds !== undefined) {
    if (
      !Array.isArray(body.pinnedThreadIds) ||
      body.pinnedThreadIds.some((threadId) => typeof threadId !== "string")
    ) {
      throw createError({
        statusCode: 400,
        message: "`pinnedThreadIds` must be an array of strings",
      });
    }
    parsed.pinnedThreadIds = [...body.pinnedThreadIds];
  }

  if (body.defaultAgentSlug !== undefined) {
    if (body.defaultAgentSlug !== null && typeof body.defaultAgentSlug !== "string") {
      throw createError({
        statusCode: 400,
        message: "`defaultAgentSlug` must be a string or null",
      });
    }
    parsed.defaultAgentSlug = body.defaultAgentSlug;
  }

  if (body.autoResume !== undefined) {
    if (!body.autoResume || typeof body.autoResume !== "object" || Array.isArray(body.autoResume)) {
      throw createError({ statusCode: 400, message: "`autoResume` must be an object" });
    }
    const autoResume = body.autoResume as Record<string, unknown>;
    if (typeof autoResume.enabled !== "boolean") {
      throw createError({
        statusCode: 400,
        message: "`autoResume.enabled` must be a boolean",
      });
    }
    if (
      typeof autoResume.timeoutMs !== "number" ||
      !Number.isInteger(autoResume.timeoutMs) ||
      autoResume.timeoutMs <= 0
    ) {
      throw createError({
        statusCode: 400,
        message: "`autoResume.timeoutMs` must be a positive integer",
      });
    }
    parsed.autoResume = {
      enabled: autoResume.enabled,
      timeoutMs: autoResume.timeoutMs,
    };
  }

  return parsed;
}

export async function handleGetProjectPreferencesRequest(
  deps: ProjectPreferencesRouteDeps,
  input: ProjectPreferencesRouteInput,
): Promise<ProjectPreferencesResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const preferences = await deps.preferences.read(input.userId, input.projectId);
  return { preferences };
}

export async function handlePutProjectPreferencesRequest(
  deps: ProjectPreferencesRouteDeps,
  input: ProjectPreferencesRouteInput & { body: UpdateProjectPreferencesRequest },
): Promise<ProjectPreferencesResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  if (input.body.defaultAgentSlug) {
    const catalog = await deps.packageRepository.transaction((tx) =>
      listProjectCatalogAgents(tx, input.projectId),
    );
    const known = catalog.some((agent) => agent.slug === input.body.defaultAgentSlug);
    if (!known) {
      throw createError({
        statusCode: 400,
        message: `Unknown defaultAgentSlug: ${input.body.defaultAgentSlug}`,
      });
    }
  }
  const preferences = await deps.preferences.upsert(input.userId, input.projectId, input.body);
  return { preferences };
}
