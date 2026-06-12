import { serializeTransport, type WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextReadRequest } from "../../../../../../lib/context-read-route.js";

function parseScheme(value: string): WorkbenchContextTreeScheme {
  if (value === "kb" || value === "work" || value === "user" || value === "fs1") return value;
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const response = await handleContextReadRequest(
    {
      workbenchRepo: app.workbenchRepo,
      contextPorts: app.contextPorts,
      objectStore: app.objectStore,
      eventSink: app.eventSink,
    },
    { workbenchId, userId: user.userId, scheme, rawPath: getQuery(event).path },
  );
  return serializeTransport(response);
});
