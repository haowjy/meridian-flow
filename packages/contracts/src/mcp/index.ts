/** MCP connections: what the database stores, the rules on names and counts, and the settings API's shapes. */
import type { Pin } from "@meridian-flow/runtime/mcp";
import type { ProjectId } from "../ids.js";

export type McpConnectionId = string;
export type McpPinId = string;
/** The saved copy of a connection's chosen tools, exactly as the server listed them. */
export type McpPin = Pin;

/** A remote address today; transport-tagged so a second kind of spec moves no column. */
export type McpConnectionSpec = { transport: "http"; url: string };

/** What a check last learned. A connection with no result has no status. */
export const MCP_CONNECTION_STATUSES = ["connected", "unreachable", "needs_sign_in"] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

/** Letters, digits, `-` and `_`, so `<connection>/<tool>` splits at the first `/`. */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MCP_NAME_MAX_LENGTH = 40;
export const isMcpConnectionName = (name: string): boolean =>
  name.length > 0 && name.length <= MCP_NAME_MAX_LENGTH && MCP_NAME_PATTERN.test(name);

/** `wanted` when no connection at the level has it, else the first free `<wanted>-2`, `-3`…, cut to fit the name limit. */
export function nextFreeName(taken: ReadonlySet<string>, wanted: string): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${wanted.slice(0, MCP_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * One connection a thread's prompt bake was made from. The pin is the one the bake read, so a
 * describe or a call finds the tool's schema and the server's name for it however the connection
 * changes afterwards.
 */
export type McpBakedConnection = {
  /** The name the thread knows it by. */
  name: string;
  connectionId: McpConnectionId;
  pinId: McpPinId;
} & McpBakedListing;

export type McpBakedListing =
  | { listing: "full" }
  /** One line in the catalogue, no tool lines: its status was bad when the bake was written. */
  | { listing: "by_name"; reason: Exclude<McpConnectionStatus, "connected"> };

export const MCP_SESSIONS_PER_ACCOUNT = 8;

/**
 * The part of Flow's address rule that needs no lookup: https, on port 443. The app refuses these
 * before sending; the server applies this and its own check for private addresses.
 */
export function mcpAddressProblem(url: URL): "not_https" | "not_port_443" | null {
  if (url.protocol !== "https:") return "not_https";
  if (url.port !== "" && url.port !== "443") return "not_port_443";
  return null;
}

/** Where a connection lives: every project of the account, or one project. */
export type McpConnectionLevel = "account" | "project";

export interface McpToolView {
  name: string;
  description: string;
  /** The server's own claim. Only read-only tools can be chosen until the owner decides how calls with effects are held. */
  readOnly: boolean;
}

export interface McpConnectionView {
  id: McpConnectionId;
  level: McpConnectionLevel;
  /** Set for a project connection. */
  projectId: ProjectId | null;
  name: string;
  url: string;
  /** Whether a token is stored. The token itself is never sent back. */
  tokenSet: boolean;
  /** Null: no result yet for the current address and token ("Checking…"). */
  status: McpConnectionStatus | null;
  /** Why the last check failed, in words a writer reads. */
  statusReason: string | null;
  /** When the check behind the status finished. */
  checkedAt: string | null;
  /** Null: no pin, so the connection is in no chat ("Choose tools"). */
  pin: {
    id: McpPinId;
    pinnedAt: string;
    server: { name: string; version: string };
    tools: McpToolView[];
  } | null;
  /** Set when a project connection of the same name stands in front of this account one. */
  shadowedBy: McpConnectionId | null;
}

export interface McpConnectionsList {
  connections: McpConnectionView[];
}

/** POST /api/mcp/connections */
export interface McpAddConnectionRequest {
  name: string;
  url: string;
  /** Sent as a bearer token; omit for a server with none. */
  token?: string;
  /** With a project id the connection belongs to that project, without one to the account. */
  projectId?: ProjectId;
}

/** The server's tools as listed just now; null when it did not answer, and the status says why. */
export interface McpAddConnectionResponse {
  connection: McpConnectionView;
  tools: McpToolView[] | null;
}

/** PATCH /api/mcp/connections/:id. Changing the address or the token makes a new session and starts a new check. */
export interface McpEditConnectionRequest {
  url?: string;
  /** A new token; an empty string clears it. */
  token?: string;
}

/** GET /api/mcp/connections/:id/tools: the server's tools now, for choosing or re-pinning. */
export interface McpListToolsResponse {
  connection: McpConnectionView;
  tools: McpToolView[] | null;
}

/** PUT /api/mcp/connections/:id/pin */
export interface McpPinRequest {
  tools: string[];
}

export interface McpConnectionResponse {
  connection: McpConnectionView;
}

export * from "./tool-results.js";
