/**
 * Shared route helpers for `/api/projects/:projectId/context/:scheme/*` routes.
 *
 * Deduplicates scheme parsing, context error → HTTP translation, and the
 * project-browse context port resolution that every route in this directory
 * performs. Route handlers import these instead of inlining their own copies.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { H3Event } from "nitro/h3";
import { createError, getQuery, getRouterParam } from "nitro/h3";
import {
  projectBrowseContextUri,
  WORK_SCOPED_BROWSE_SCHEMES,
} from "../../../../../../domains/context/browse-layer-scheme.js";
import { contextPortForProjectBrowse } from "../../../../../../domains/context/context-port-resolution.js";
import type { ContextError, ContextPort } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import type { AppServices } from "../../../../../../lib/compose.js";

export function parseScheme(value: string): ProjectContextTreeScheme {
  if (
    value === "manuscript" ||
    value === "kb" ||
    value === "work" ||
    value === "uploads" ||
    value === "user"
  ) {
    return value;
  }
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}

export function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "conflict":
      throw createError({ statusCode: 409, message: "Context path conflict" });
    case "invalid_operation":
      throw createError({ statusCode: 400, message: "Invalid context operation" });
    case "not_found":
      throw createError({ statusCode: 404, message: "Context path not found" });
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
}

export const toUri = projectBrowseContextUri;

/** Reject `.`/`..` segments and empty paths — defense-in-depth at the route boundary. */
export function sanitizePath(raw: string): string {
  const path = raw.trim();
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0)
    throw createError({ statusCode: 400, message: "`path` must name a non-root entry" });
  for (const seg of segments)
    if (seg === "." || seg === "..")
      throw createError({ statusCode: 400, message: "`path` may not contain '.' or '..'" });
  return path;
}

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
