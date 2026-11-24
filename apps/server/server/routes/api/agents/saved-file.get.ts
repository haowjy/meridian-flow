import { savedAgentFileQuerySchema } from "@meridian/contracts/agents";
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { requireProjectOwner } from "../../../domains/projects/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { parseOptionalRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const projectId = parseOptionalRequestId(query.projectId, "projectId");
  const file = savedAgentFileQuerySchema.safeParse(query);
  if (!file.success) throw createError({ statusCode: 400, message: "level and path are required" });
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const text = await app.agentCatalog.savedFile(user.userId, { projectId, ...file.data });
  if (text === undefined) throw createError({ statusCode: 404, message: "No saved file there" });
  return { text };
});
