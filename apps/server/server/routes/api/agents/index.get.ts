/** GET /api/agents: authenticated account/system revisions with bounded pagination. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { parseAgentCatalogQuery } from "../../../lib/agent-catalog-query.js";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return serializeTransport(
    await app.agentCatalog.list(user.userId, parseAgentCatalogQuery(getQuery(event))),
  );
});
