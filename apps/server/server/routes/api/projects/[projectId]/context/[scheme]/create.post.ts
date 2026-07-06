import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam, readBody } from "nitro/h3";
import {
  projectBrowseContextUri,
  WORK_SCOPED_BROWSE_SCHEMES,
} from "../../../../../../domains/context/browse-layer-scheme.js";
import { contextPortForProjectBrowse } from "../../../../../../domains/context/context-port-resolution.js";
import type { ContextError } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

interface CreateContextEntryBody {
  type: "file" | "folder";
  path: string;
  content?: string;
}
function parseScheme(value: string): ProjectContextTreeScheme {
  if (
    value === "manuscript" ||
    value === "kb" ||
    value === "scratch" ||
    value === "uploads" ||
    value === "user"
  ) {
    return value;
  }
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}
function parseBody(raw: unknown): CreateContextEntryBody {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Partial<CreateContextEntryBody>;
  if (body.type !== "file" && body.type !== "folder")
    throw createError({ statusCode: 400, message: "`type` must be 'file' or 'folder'" });
  if (typeof body.path !== "string" || body.path.trim() === "")
    throw createError({ statusCode: 400, message: "`path` is required" });
  if (body.content !== undefined && typeof body.content !== "string")
    throw createError({ statusCode: 400, message: "`content` must be a string" });
  const path = body.path.trim();
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0)
    throw createError({ statusCode: 400, message: "`path` must name a non-root entry" });
  for (const seg of segments)
    if (seg === "." || seg === "..")
      throw createError({ statusCode: 400, message: "`path` may not contain '.' or '..'" });
  return { type: body.type, path, content: body.content };
}
function contextErrorToHttp(error: ContextError): never {
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
const toUri = projectBrowseContextUri;
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const query = getQuery(event);
  const workId = typeof query.workId === "string" ? query.workId : null;
  const body = parseBody(await readBody(event));
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
  const uri = toUri(scheme, body.path, workId);
  const result =
    body.type === "folder"
      ? await port.mkdir(uri, { origin: { type: "human", userId: user.userId } })
      : await port.write(uri, body.content ?? "", {
          origin: { type: "human", userId: user.userId },
        });
  if (!result.ok) contextErrorToHttp(result.error);
  return { ok: true as const };
});
