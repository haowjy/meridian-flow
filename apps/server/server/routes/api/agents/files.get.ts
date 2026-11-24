import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { requireProjectOwner } from "../../../domains/projects/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { parseOptionalRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = parseOptionalRequestId(getQuery(event).projectId, "projectId");
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  return serializeTransport(await app.agentCatalog.files(user.userId, { projectId }));
});
