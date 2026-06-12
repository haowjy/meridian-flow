import type { WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import type { ContextError } from "../../../../../../domains/context/index.js";
import { requireWorkbenchOwner } from "../../../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

interface CreateContextEntryBody {
  type: "file" | "folder";
  path: string;
  content?: string;
}
function parseScheme(value: string): WorkbenchContextTreeScheme {
  if (value === "kb" || value === "work" || value === "user" || value === "fs1") return value;
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
    case "not_found":
      throw createError({ statusCode: 404, message: "Context path not found" });
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
}
const toUri = (scheme: WorkbenchContextTreeScheme, path: string) =>
  `${scheme}://${path.replace(/^\/+/, "").replace(/\/+$/, "")}`;
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const body = parseBody(await readBody(event));
  await requireWorkbenchOwner({ workbenches: app.workbenchRepo }, workbenchId, user.userId);
  const port = app.contextPorts.forWorkbench(workbenchId, user.userId);
  const uri = toUri(scheme, body.path);
  const result =
    body.type === "folder"
      ? await port.mkdir(uri, { origin: { type: "human", userId: user.userId } })
      : await port.write(uri, body.content ?? "", {
          origin: { type: "human", userId: user.userId },
        });
  if (!result.ok) contextErrorToHttp(result.error);
  return { ok: true as const };
});
