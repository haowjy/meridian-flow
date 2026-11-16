/** PUT /api/mcp/connections/:connectionId/pin: keeps the chosen tools as the server lists them now. Read-only tools only. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { connectionOperation, parsePinRequest } from "../../../../../lib/mcp-connections-route.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const id = requireRequestId(getRouterParam(event, "connectionId"), "connectionId");
  const { tools } = parsePinRequest(await readBody(event));
  const connection = await connectionOperation(() =>
    app.mcpConnections.pin(user.userId, id, tools),
  );
  return serializeTransport({ connection });
});
