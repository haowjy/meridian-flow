/** GET /api/agents: the Agents of the built-in, user and (with `projectId`) project levels. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { requireProjectOwner } from "../../../domains/projects/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { parseOptionalRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const projectId = parseOptionalRequestId(query.projectId, "projectId");
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const [catalog, lastStartedSlug] = await Promise.all([
    app.agentCatalog.list(user.userId, { projectId }),
    projectId ? app.threadRepos.threads.lastStartedAgentSlug(user.userId, projectId) : null,
  ]);
  return serializeTransport({ ...catalog, lastStartedSlug });
});
