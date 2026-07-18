/** HTTP edge for committing a writer-visible context identity. */

import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextMoveRequest } from "../../../../../../lib/context-move-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result = await handleContextMoveRequest(
    {
      projectRepo: app.projectRepo,
      workRepo: app.workRepo,
      contextPorts: app.contextPorts,
    },
    {
      projectId: getRouterParam(event, "projectId") ?? "",
      userId: user.userId,
      sourceScheme: getRouterParam(event, "scheme") ?? "",
      body: await readBody(event),
    },
  );
  if (result.status === "conflict") setResponseStatus(event, 409);
  return result;
});
