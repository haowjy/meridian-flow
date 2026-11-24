import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { connectionOperation } from "../../../../../lib/mcp-connections-route.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const id = requireRequestId(getRouterParam(event, "connectionId"), "connectionId");
  await connectionOperation(() => app.mcpConnections.remove(user.userId, id));
  setResponseStatus(event, 204);
  return null;
});
