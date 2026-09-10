/**
 * Shared route helpers for `/api/projects/:projectId/context/:scheme/*` routes.
 *
 * Deduplicates scheme parsing, context error → HTTP translation, and the
 * project-browse context port resolution that every route in this directory
 * performs. Writer-input validation lives in the route-core validation seam.
 */

import type { CanonicalContextAuthority } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { H3Event } from "nitro/h3";
import { createError, getQuery, getRouterParam } from "nitro/h3";
import {
  isWorkScopedBrowseScheme,
  projectBrowseContextUri,
} from "../../../../../../domains/context/browse-layer-scheme.js";
import {
  contextPortForProjectBrowse,
  contextPortForProjectRecovery,
} from "../../../../../../domains/context/context-port-resolution.js";
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
export async function resolveContextRoute(
  event: H3Event,
  options: { recoverAcrossProject?: boolean } = {},
): Promise<{
  app: AppServices;
  userId: string;
  projectId: string;
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  authority: CanonicalContextAuthority;
  port: ContextPort;
}> {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const query = getQuery(event);
  const workId = typeof query.workId === "string" ? query.workId : null;
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const deps = {
    contextPorts: app.contextPorts,
    works: app.workRepo,
    workAuthorityResolver: app.workAuthorityResolver,
  };
  const port = options.recoverAcrossProject
    ? await contextPortForProjectRecovery({
        deps,
        projectId,
        userId: user.userId,
        requestedWorkId: workId,
      })
    : await contextPortForProjectBrowse({ deps, projectId, userId: user.userId, workId });
  if (!port) throw createError({ statusCode: 404, message: "Work not found" });
  let authority: CanonicalContextAuthority = { kind: "contextual" };
  if (isWorkScopedBrowseScheme(scheme)) {
    if (!workId) authority = { kind: "none" };
    else {
      const resolved = await app.workAuthorityResolver.byId(projectId, workId);
      if (!resolved) {
        throw createError({ statusCode: 404, message: "Work not found" });
      }
      authority = resolved;
    }
  }
  return { app, userId: user.userId, projectId, scheme, workId, authority, port };
}
