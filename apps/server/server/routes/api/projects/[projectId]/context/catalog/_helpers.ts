/** Authenticated transport parsing for thin context-catalog routes. */
import type { CatalogScope, FileAccessLevel } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import type { H3Event } from "nitro/h3";
import { createError, getQuery, getRouterParam } from "nitro/h3";
import {
  type FileTarget,
  isFileAccessDenied,
} from "../../../../../../domains/file-policy/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import type { AppServices } from "../../../../../../lib/app.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
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
      throw createError({ statusCode: 404, message: "Work not found" });
    }
    scope = { kind, projectId, workId };
  } else {
    throw createError({ statusCode: 400, message: `Unsupported catalog scope: ${kind}` });
  }
  return { app, query, scope, userId: user.userId };
}

/**
 * The person's level on the files a catalog scope owns: the project's for the
 * project scope, the Work's for a Work scope (file-access §6). The client
 * reads it; it never recomputes access.
 */
export async function catalogScopeAccess(
  app: AppServices,
  userId: string,
  scope: CatalogScope,
): Promise<FileAccessLevel | undefined> {
  if (scope.kind === "user") return undefined;
  const target: FileTarget =
    scope.kind === "project"
      ? {
          kind: "container",
          scheme: "manuscript",
          owner: { scope: "project", projectId: scope.projectId },
        }
      : { kind: "container", scheme: "scratch", owner: { scope: "work", workId: scope.workId } };
  const grant = await app.fileAccess.authorize({ accountId: userId as UserId }, target, "edit");
  if (!isFileAccessDenied(grant)) return "edit";
  return grant.level === "none" ? undefined : grant.level;
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
