import { type ProjectContextTreeScheme, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextReadRequest } from "../../../../../../lib/context-read-route.js";

function parseScheme(value: string): ProjectContextTreeScheme {
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
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const query = getQuery(event);
  const workId = typeof query.workId === "string" ? query.workId : null;
  const response = await handleContextReadRequest(
    {
      projectRepo: app.projectRepo,
      workRepo: app.workRepo,
      contextPorts: app.contextPorts,
      objectStore: app.objectStore,
      eventSink: app.eventSink,
    },
    { projectId, userId: user.userId, scheme, rawPath: query.path, workId },
  );
  return serializeTransport(response);
});
