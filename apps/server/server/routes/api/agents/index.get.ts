/** GET /api/agents: authenticated account/system revisions with bounded pagination. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { requireProjectOwner } from "../../../domains/projects/index.js";
import { parseAgentCatalogQuery } from "../../../lib/agent-catalog-query.js";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { parseOptionalRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const projectId = parseOptionalRequestId(query.projectId, "projectId");
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  return serializeTransport(
    await app.agentCatalog.list(user.userId, { ...parseAgentCatalogQuery(query), projectId }),
  );
});
