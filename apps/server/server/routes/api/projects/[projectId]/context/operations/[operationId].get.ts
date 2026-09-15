/** Resolve an ambiguous namespace attempt without resolving its obsolete source path or Work. */
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { contextPortForProjectBrowse } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const operationId = requireRequestId(getRouterParam(event, "operationId"), "operationId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const port = await contextPortForProjectBrowse({
    deps: {
      contextPorts: app.contextPorts,
      works: app.workRepo,
      workAuthorityResolver: app.workAuthorityResolver,
    },
    projectId,
    userId: user.userId,
    workId: null,
  });
  if (!port) throw createError({ statusCode: 503, message: "Project context is unavailable" });
  return { receipt: await port.lookupOperation(operationId) };
});
