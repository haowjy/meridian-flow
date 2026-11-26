import type {
  McpAddConnectionRequest,
  McpAddConnectionResponse,
  McpConnectionId,
  McpConnectionResponse,
  McpConnectionsList,
  McpConnectionView,
  McpEditConnectionRequest,
  McpListToolsResponse,
  McpPinRequest,
} from "@meridian/contracts/mcp";
import { deleteRequest, getJson, patchJson, postJson, putJson } from "./http-client";

const CONNECTIONS = "/api/mcp/connections";
const connectionPath = (id: McpConnectionId) => `${CONNECTIONS}/${encodeURIComponent(id)}`;

/** The account's connections, and with a project that project's, shadows marked. Reading starts the checks that are due. */
export async function listMcpConnections(
  signal: AbortSignal,
  projectId: string | null,
): Promise<McpConnectionView[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : "";
  return (await getJson<McpConnectionsList>(`${CONNECTIONS}${query}`, { signal })).connections;
}

export function addMcpConnection(request: McpAddConnectionRequest) {
  return postJson<McpAddConnectionResponse>(CONNECTIONS, request);
}

export async function editMcpConnection(id: McpConnectionId, change: McpEditConnectionRequest) {
  return (await patchJson<McpConnectionResponse>(connectionPath(id), change)).connection;
}

export function listMcpConnectionTools(signal: AbortSignal, id: McpConnectionId) {
  return getJson<McpListToolsResponse>(`${connectionPath(id)}/tools`, { signal });
}

export async function pinMcpConnection(id: McpConnectionId, tools: string[]) {
  const body: McpPinRequest = { tools };
  return (await putJson<McpConnectionResponse>(`${connectionPath(id)}/pin`, body)).connection;
}

export async function removeMcpConnection(id: McpConnectionId): Promise<void> {
  await deleteRequest(connectionPath(id));
}

export async function undoRemoveMcpConnection(id: McpConnectionId) {
  return (await postJson<McpConnectionResponse>(`${connectionPath(id)}/undo`, {})).connection;
}

export async function checkMcpConnection(id: McpConnectionId) {
  return (await postJson<McpConnectionResponse>(`${connectionPath(id)}/check`, {})).connection;
}
