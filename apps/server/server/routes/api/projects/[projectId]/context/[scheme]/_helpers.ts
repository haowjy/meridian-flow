import { throwContextWorkUnavailableHttpError } from "../../../../../../lib/context-error-http.js";
/**
 * Shared route helpers for `/api/projects/:projectId/context/:scheme/*` routes.
 *
 * Deduplicates scheme parsing, context error → HTTP translation, and the
 * project-browse context port resolution that every route in this directory
 * performs. Writer-input validation lives in the route-core validation seam.
 */

import {
  type CanonicalContextAuthority,
  isWorkScopedScheme,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { H3Event } from "nitro/h3";
import { createError, getQuery, getRouterParam } from "nitro/h3";
import { projectBrowseContextUri } from "../../../../../../domains/context/browse-layer-scheme.js";
import {
  contextPortForProjectBrowse,
  contextPortForProjectRecovery,
} from "../../../../../../domains/context/context-port-resolution.js";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import type { FileTarget } from "../../../../../../domains/file-policy/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import type { AppServices } from "../../../../../../lib/compose.js";
import {
  containerTarget,
  requireFileGrant,
  withEditGrants,
} from "../../../../../../lib/file-access-http.js";

export { contextErrorToHttp } from "../../../../../../lib/context-error-http.js";
export { documentTarget } from "../../../../../../lib/file-access-http.js";

export function parseScheme(value: string): ProjectContextTreeScheme {
  if (isProjectContextTreeScheme(value)) return value;
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}

export const toUri = projectBrowseContextUri;

/** Auth and project ownership, before anything that depends on the route's Work authority. */
export type ProjectRouteContext = { app: AppServices; userId: string; projectId: string };

export async function requireProjectRouteContext(event: H3Event): Promise<ProjectRouteContext> {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  return { app, userId: user.userId, projectId };
}

export type ResolvedContextRoute = ProjectRouteContext & {
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  authority: CanonicalContextAuthority;
  port: ContextPort;
  /** The folder this route's scheme names, for creates and uploads (file-access §4). */
  container: FileTarget;
  /** Runs a write under the writer's edit grants on these targets; refusals become 404 or 403. */
  edit<T>(targets: readonly FileTarget[], operation: () => Promise<T>): Promise<T>;
};

/** Common preamble: auth → project ownership → scheme → workId → context port. */
export async function resolveContextRoute(
  event: H3Event,
  options: { recoverAcrossProject?: boolean } = {},
): Promise<ResolvedContextRoute> {
  return resolveContextRouteFor(event, await requireProjectRouteContext(event), options);
}

/**
 * The rest of a route for a caller that already authenticated: a create reads its held id first,
 * because a destination in a deleted Work refuses the route while a replay must still answer.
 */
export async function resolveContextRouteFor(
  event: H3Event,
  context: ProjectRouteContext,
  options: { recoverAcrossProject?: boolean } = {},
): Promise<ResolvedContextRoute> {
  const { app, userId: authenticatedUserId, projectId } = context;
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const query = getQuery(event);
  const rootThreadId = typeof query.rootThreadId === "string" ? query.rootThreadId : null;
  if (rootThreadId && (scheme !== "scratch" || query.workId))
    throw createError({ statusCode: 400, message: "Choose one Scratch owner" });
  const chatId = typeof query.chatId === "string" ? query.chatId : null;
  if (chatId && (scheme !== "uploads" || query.workId || rootThreadId))
    throw createError({ statusCode: 400, message: "Choose one uploads owner" });
  const workId = typeof query.workId === "string" ? query.workId : null;
  const userId = authenticatedUserId;
  const deps = {
    contextPorts: app.contextPorts,
    works: app.workRepo,
    workAuthorityResolver: app.workAuthorityResolver,
  };
  const port = options.recoverAcrossProject
    ? await contextPortForProjectRecovery({
        deps,
        projectId,
        userId,
        requestedWorkId: workId,
      })
    : await contextPortForProjectBrowse({
        deps,
        projectId,
        userId,
        workId,
        rootThreadId,
        chatId,
      });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");
  let authority: CanonicalContextAuthority = { kind: "contextual" };
  if (rootThreadId) {
    const lineage = await app.contextPorts.lineages.byId(projectId, rootThreadId);
    if (!lineage) throw createError({ statusCode: 404, message: "Chat not found" });
    authority = { kind: "lineage", rootThreadRef: lineage.rootThreadRef };
  } else if (chatId) {
    // A New chat's composer uploads before the chat row exists: no handle yet, so no qualifier.
    const chat = await app.contextPorts.topPrimaryChats.resolveTopPrimaryChat(chatId as ThreadId);
    authority = chat ? { kind: "chat", chatRef: chat.chatRef } : { kind: "contextual" };
  } else if (scheme === "uploads") {
    throw createError({ statusCode: 400, message: "Uploads belong to a chat" });
  } else if (isWorkScopedScheme(scheme)) {
    if (!workId)
      throw createError({ statusCode: 400, message: "Scratch belongs to a Work or a chat" });
    else {
      const resolved = await app.workAuthorityResolver.byId(projectId, workId);
      if (!resolved) {
        throwContextWorkUnavailableHttpError("work_missing");
      }
      authority = resolved;
    }
  }
  if (
    scheme === "scratch" &&
    !rootThreadId &&
    !("workHandle" in authority && authority.workHandle !== null)
  )
    throw createError({ statusCode: 400, message: "Scratch requires a chat or named Work" });
  const container: FileTarget = rootThreadId
    ? { kind: "container", scheme, owner: { scope: "lineage", projectId, rootThreadId } }
    : await containerTarget(app.workRepo, { projectId, scheme, workId, chatId });
  const edit = async <T>(targets: readonly FileTarget[], operation: () => Promise<T>) => {
    const grants = [];
    for (const target of targets) {
      grants.push(await requireFileGrant(app.fileAccess, userId, target, "edit"));
    }
    return withEditGrants(app.fileAccess, grants, operation);
  };
  return {
    app,
    userId,
    projectId,
    scheme,
    workId,
    authority,
    port,
    container,
    edit,
  };
}
