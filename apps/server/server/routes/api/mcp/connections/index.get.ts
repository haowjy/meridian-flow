/** GET /api/mcp/connections: the writer's connections, account level and (with `projectId`) that project's, with shadows and status. */
import type { McpConnectionsList } from "@meridian/contracts/mcp";
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { parseOptionalRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = parseOptionalRequestId(getQuery(event).projectId, "projectId");
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const connections = await app.mcpConnections.list(user.userId, projectId ?? null);
  return serializeTransport({ connections } satisfies McpConnectionsList);
});
