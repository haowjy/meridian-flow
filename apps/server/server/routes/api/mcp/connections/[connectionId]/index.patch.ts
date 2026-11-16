/** PATCH /api/mcp/connections/:connectionId: a new address or token. A new settings version, a new session, a new check. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  connectionOperation,
  parseEditConnection,
} from "../../../../../lib/mcp-connections-route.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const id = requireRequestId(getRouterParam(event, "connectionId"), "connectionId");
  const change = parseEditConnection(await readBody(event));
  const connection = await connectionOperation(() =>
    app.mcpConnections.edit(user.userId, id, change),
  );
  return serializeTransport({ connection });
});
