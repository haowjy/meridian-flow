import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextReadRequest } from "../../../../../../lib/context-read-route.js";
import { parseScheme } from "./_helpers.js";

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
