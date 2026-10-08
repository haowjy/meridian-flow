/** Authenticated transport parsing for thin context-catalog routes. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type { H3Event } from "nitro/h3";
import { createError, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { throwContextWorkUnavailableHttpError } from "../../../../../../lib/context-error-http.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export async function resolveCatalogRoute(event: H3Event) {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const query = getQuery(event);
  const kind = typeof query.scope === "string" ? query.scope : "project";
  let scope: CatalogScope;
  if (kind === "project") scope = { kind, projectId };
  else if (kind === "user") scope = { kind, userId: user.userId };
  else if (kind === "work") {
    const workId = requireRequestId(query.workId, "workId");
    if (!(await app.workAuthorityResolver.byId(projectId, workId))) {
      throwContextWorkUnavailableHttpError("work_missing");
    }
    scope = { kind, projectId, workId };
  } else if (kind === "lineage") {
    const rootThreadId = requireRequestId(query.rootThreadId, "rootThreadId");
    if (!(await app.contextPorts.lineages.byId(projectId, rootThreadId)))
      throw createError({ statusCode: 404, message: "Chat not found" });
    scope = { kind, projectId, rootThreadId };
  } else {
    throw createError({ statusCode: 400, message: `Unsupported catalog scope: ${kind}` });
  }
  return { app, query, scope, userId: user.userId };
}

export function optionalPositiveSafeIntegerQuery(
  query: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw createError({ statusCode: 400, message: `\`${name}\` must be a positive safe integer` });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw createError({ statusCode: 400, message: `\`${name}\` must be a positive safe integer` });
  }
  return parsed;
}

export function requiredQueryString(query: Record<string, unknown>, name: string): string {
  const value = query[name];
  if (typeof value !== "string" || !value) {
    throw createError({ statusCode: 400, message: `Missing ${name}` });
  }
  return value;
}
