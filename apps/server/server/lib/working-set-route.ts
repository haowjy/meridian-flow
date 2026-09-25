/** Project working-set route core: validates snapshot references after enforcing project ownership. */
import {
  isWorkScopedProjectContextScheme,
  parseWorkingSetRouteList,
  type WorkAuthorityScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { ProjectContextAvailabilityPort } from "../domains/context/index.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { WorkingSetRepository, WorkingSetRow } from "../domains/working-set/index.js";
import { requireRequestId } from "./request-id.js";

export type PutWorkingSetRequest = { recentRoutes: WorkingSetRoute[] };

export interface WorkingSetRouteDeps {
  projectRepo: ProjectRepository;
  workingSet: WorkingSetRepository;
  works: WorkRepository;
  projectContextAvailability: ProjectContextAvailabilityPort;
}

function isWorkScopedRoute(
  route: WorkingSetRoute,
): route is Extract<WorkingSetRoute, { scheme: WorkAuthorityScheme }> {
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
  const seenDocumentIds = new Set<string>();
  const recentRoutes = routes.value
    .map((route) => ({
      ...route,
      documentId: requireRequestId(route.documentId, "recentRoutes[].documentId"),
      ...(isWorkScopedRoute(route) && route.workId !== null
        ? { workId: requireRequestId(route.workId, "recentRoutes[].workId") }
        : {}),
    }))
    .filter((route) => {
      if (seenDocumentIds.has(route.documentId)) return false;
      seenDocumentIds.add(route.documentId);
      return true;
    }) as WorkingSetRoute[];
  return { recentRoutes };
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
    if (route.workId === null) continue;
    const work = await deps.works.findById(route.workId);
    if (!work || work.projectId !== input.projectId) {
      throw createError({
        statusCode: 400,
        message: "Working-set route references another project",
      });
    }
  }

  if (input.body.recentRoutes.length > 0) {
    const documentIds = input.body.recentRoutes.map((route) => route.documentId);
    const availability = await deps.projectContextAvailability.lookup(
      { projectId: input.projectId, documentIds },
      { userId: input.userId },
    );
    if (
      availability.resolutions.length !== documentIds.length ||
      availability.resolutions.some(
        (resolution, index) =>
          resolution.documentId !== documentIds[index] || resolution.kind !== "available",
      )
    ) {
      throw createError({ statusCode: 400, message: "Invalid working-set route" });
    }
  }
  return deps.workingSet.upsert(input.userId, input.projectId, input.body);
}
