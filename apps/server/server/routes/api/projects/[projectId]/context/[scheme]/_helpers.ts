/**
 * Shared route helpers for `/api/projects/:projectId/context/:scheme/*` routes.
 *
 * Deduplicates scheme parsing, context error → HTTP translation, and the
 * project-browse context port resolution that every route in this directory
 * performs. Writer-input validation lives in the route-core validation seam.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { H3Event } from "nitro/h3";
import { createError, getQuery, getRouterParam } from "nitro/h3";
import {
  projectBrowseContextUri,
  WORK_SCOPED_BROWSE_SCHEMES,
} from "../../../../../../domains/context/browse-layer-scheme.js";
import { contextPortForProjectBrowse } from "../../../../../../domains/context/context-port-resolution.js";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import type { AppServices } from "../../../../../../lib/compose.js";

export { contextErrorToHttp } from "../../../../../../lib/context-error-http.js";

export function parseScheme(value: string): ProjectContextTreeScheme {
  if (isProjectContextTreeScheme(value)) return value;
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}

export const toUri = projectBrowseContextUri;

/** Common preamble: auth → project ownership → scheme → workId → context port. */
export async function resolveContextRoute(event: H3Event): Promise<{
  app: AppServices;
  userId: string;
  projectId: string;
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  port: ContextPort;
}> {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const query = getQuery(event);
  const workId = typeof query.workId === "string" ? query.workId : null;
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  if (WORK_SCOPED_BROWSE_SCHEMES.has(scheme) && !workId) {
    throw createError({ statusCode: 400, message: "`workId` is required" });
  }
  const port = await contextPortForProjectBrowse({
    deps: { contextPorts: app.contextPorts, works: app.workRepo },
    projectId,
    userId: user.userId,
    workId,
  });
  if (!port) throw createError({ statusCode: 404, message: "Work not found" });
  return { app, userId: user.userId, projectId, scheme, workId, port };
}
