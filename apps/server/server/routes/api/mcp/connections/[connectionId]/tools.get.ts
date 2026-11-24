import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { connectionOperation } from "../../../../../lib/mcp-connections-route.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const id = requireRequestId(getRouterParam(event, "connectionId"), "connectionId");
  return serializeTransport(
    await connectionOperation(() => app.mcpConnections.tools(user.userId, id)),
  );
});
