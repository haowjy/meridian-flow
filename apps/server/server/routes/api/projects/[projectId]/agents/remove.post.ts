/** Hide a catalog Agent in this Project without changing its source or existing chats. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireAgentSelection, requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const selection = requireAgentSelection(await readBody(event));
  if (!(await app.agentCatalog.removeFromProject(user.userId, projectId, selection))) {
    throw createError({ statusCode: 400, message: "Agent cannot be removed from this project" });
  }
  return serializeTransport({ removed: true });
});
