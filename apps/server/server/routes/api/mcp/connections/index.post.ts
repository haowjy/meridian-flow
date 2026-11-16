/** POST /api/mcp/connections: adds a connection and lists its server's tools. A server that does not answer is saved with no pin. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { connectionOperation, parseAddConnection } from "../../../../lib/mcp-connections-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const input = parseAddConnection(await readBody(event));
  if (input.projectId)
    await requireProjectOwner({ projects: app.projectRepo }, input.projectId, user.userId);
  return serializeTransport(
    await connectionOperation(() => app.mcpConnections.add(user.userId, input)),
  );
});
