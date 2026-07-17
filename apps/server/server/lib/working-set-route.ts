/** Project working-set route core: validates snapshot references after enforcing project ownership. */
import {
  isWorkScopedProjectContextScheme,
  parseWorkingSetRouteList,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { ThreadRepository } from "../domains/threads/ports/index.js";
import type { WorkingSetRepository, WorkingSetRow } from "../domains/working-set/index.js";

export type PutWorkingSetRequest = {
  recentRoutes: WorkingSetRoute[];
  lastThreadId: ThreadId | null;
};

export interface WorkingSetRouteDeps {
  projectRepo: ProjectRepository;
  workingSet: WorkingSetRepository;
  works: WorkRepository;
  threads: ThreadRepository;
}

function isWorkScopedRoute(
  route: WorkingSetRoute,
): route is Extract<WorkingSetRoute, { scheme: "scratch" | "uploads" }> {
  return isWorkScopedProjectContextScheme(route.scheme);
}

export function parsePutWorkingSetRequest(raw: unknown): PutWorkingSetRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = raw as Record<string, unknown>;
  const routes = parseWorkingSetRouteList(body.recentRoutes);
  if (!routes.ok) throw createError({ statusCode: 400, message: routes.message });
  if (routes.value.length > 3) {
    throw createError({ statusCode: 400, message: "`recentRoutes` must contain at most 3 routes" });
  }
  if (body.lastThreadId !== null && typeof body.lastThreadId !== "string") {
    throw createError({ statusCode: 400, message: "`lastThreadId` must be a string or null" });
  }
  return { recentRoutes: routes.value, lastThreadId: body.lastThreadId as ThreadId | null };
}

export async function handleGetWorkingSetRequest(
  deps: WorkingSetRouteDeps,
  input: { userId: UserId; projectId: ProjectId },
): Promise<WorkingSetRow | null> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return deps.workingSet.get(input.userId, input.projectId);
}

export async function handlePutWorkingSetRequest(
  deps: WorkingSetRouteDeps,
  input: { userId: UserId; projectId: ProjectId; body: PutWorkingSetRequest },
): Promise<{ revision: number }> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);

  for (const route of input.body.recentRoutes) {
    if (!isWorkScopedRoute(route)) continue;
    const work = await deps.works.findById(route.workId);
    if (!work || work.projectId !== input.projectId) {
      throw createError({
        statusCode: 400,
        message: "Working-set route references another project",
      });
    }
  }

  if (input.body.lastThreadId !== null) {
    const thread = await deps.threads.findById(input.body.lastThreadId);
    if (!thread || thread.projectId !== input.projectId) {
      throw createError({
        statusCode: 400,
        message: "`lastThreadId` does not belong to this project",
      });
    }
  }
  return deps.workingSet.upsert(input.userId, input.projectId, input.body);
}
