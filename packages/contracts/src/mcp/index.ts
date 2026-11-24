import type { Pin } from "@meridian-flow/runtime/mcp";
import type { ProjectId } from "../ids.js";

export type McpConnectionId = string;
export type McpPinId = string;
export type McpPin = Pin;

export type McpConnectionSpec = { transport: "http"; url: string };

export const MCP_CONNECTION_STATUSES = ["connected", "unreachable", "needs_sign_in"] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MCP_NAME_MAX_LENGTH = 40;
export const isMcpConnectionName = (name: string): boolean =>
  name.length > 0 && name.length <= MCP_NAME_MAX_LENGTH && MCP_NAME_PATTERN.test(name);

export function nextFreeName(taken: ReadonlySet<string>, wanted: string): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${wanted.slice(0, MCP_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type McpBakedConnection = {
  name: string;
  connectionId: McpConnectionId;
  pinId: McpPinId;
} & McpBakedListing;

export type McpBakedListing =
  | { listing: "full" }
  | { listing: "by_name"; reason: Exclude<McpConnectionStatus, "connected"> };

export const MCP_SESSIONS_PER_ACCOUNT = 8;

export function mcpAddressProblem(url: URL): "not_https" | "not_port_443" | null {
  if (url.protocol !== "https:") return "not_https";
  if (url.port !== "" && url.port !== "443") return "not_port_443";
  return null;
}

export type McpConnectionLevel = "account" | "project";

export interface McpToolView {
  name: string;
  description: string;
  readOnly: boolean;
}

export interface McpConnectionView {
  id: McpConnectionId;
  level: McpConnectionLevel;
  projectId: ProjectId | null;
  name: string;
  url: string;
  tokenSet: boolean;
  status: McpConnectionStatus | null;
  statusReason: string | null;
  checkedAt: string | null;
  pin: {
    id: McpPinId;
    pinnedAt: string;
    server: { name: string; version: string };
    tools: McpToolView[];
  } | null;
  shadowedBy: McpConnectionId | null;
}

export interface McpConnectionsList {
  connections: McpConnectionView[];
}

export interface McpAddConnectionRequest {
  name: string;
  url: string;
  token?: string;
  projectId?: ProjectId;
}

export interface McpAddConnectionResponse {
  connection: McpConnectionView;
  tools: McpToolView[] | null;
}

export interface McpEditConnectionRequest {
  url?: string;
  token?: string;
}

export interface McpListToolsResponse {
  connection: McpConnectionView;
  tools: McpToolView[] | null;
}

export interface McpPinRequest {
  tools: string[];
}

export interface McpConnectionResponse {
  connection: McpConnectionView;
}

export * from "./tool-results.js";
