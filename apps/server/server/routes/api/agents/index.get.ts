/** GET /api/agents: enabled primary builtin agents for Home (no workbench yet). */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { handleGetBuiltinAgentsRequest } from "../../../lib/builtin-agents-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);

  const response = await handleGetBuiltinAgentsRequest({
    packageRepository: app.packageRepository,
  });

  return serializeTransport(response);
});
