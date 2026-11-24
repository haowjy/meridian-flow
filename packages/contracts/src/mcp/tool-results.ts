import type { JsonObject, JsonValue, StoredMediaPart } from "../threads/index.js";

export type McpCallOutcome =
  | "answered"
  | "tool_error"
  | "rejected"
  | "too_large"
  | "unreachable"
  | "unauthorized"
  | "aborted"
  | "unknown_tool"
  | "connection_removed";

export type McpFailureCode = `mcp_${Exclude<McpCallOutcome, "answered">}`;

export interface McpCallResult {
  connection: string | null;
  tool: string | null;
  id: string;
  outcome: McpCallOutcome;
  arguments: JsonObject;
  recordId: string | null;
  code?: McpFailureCode;
  message?: string;
  ms?: number;
  reply?: { text: string; cut: boolean; media?: StoredMediaPart[] };
  schema?: string;
}

export interface McpDescribedItem {
  name: string;
  kind: "tool" | "connection" | "unknown";
  connection: string | null;
  tool: string | null;
  tools?: string[];
}

export interface McpDescribeResult {
  items: McpDescribedItem[];
  text: string;
}

export type McpScriptCall = McpCallResult & { sequence: number };

export type McpRunEnded =
  | "returned"
  | "threw"
  | "timed_out"
  | "too_large"
  | "aborted"
  | "unavailable"
  | "rejected_code";

export interface McpRunResult {
  ended: McpRunEnded;
  value?: JsonValue;
  error?: { name: string; message: string; line?: number; column?: number };
  limit?: "wall" | "cpu";
  limitMs?: number;
  bytes?: number;
  calls: McpScriptCall[];
  logs?: { text: string; cutBytes: number };
  text: string;
}
