/** The typed `result` of the two connection tools, which the chat rows read. */
import type { JsonObject, StoredMediaPart } from "../threads/index.js";

/**
 * How one `mcp_call` ended. `answered` is the tool's reply; `tool_error` is the tool running and
 * reporting a problem (a bad argument, nothing found); `rejected` is the server refusing the
 * request; `too_large` is a reply the client did not keep; `unreachable` is no answer;
 * `unauthorized` is a 401; `aborted` is the writer stopping the run. The last two are made by
 * Flow without calling the server: the thread holds no such tool, or its connection was removed.
 */
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

/** The `code` of every outcome that is not `answered`: `mcp_` and the outcome. */
export type McpFailureCode = `mcp_${Exclude<McpCallOutcome, "answered">}`;

export interface McpCallResult {
  /** The connection's name as the thread knows it; null when the id named none the thread holds. */
  connection: string | null;
  /** The server's name for the tool; null with `connection`. */
  tool: string | null;
  /** The id the model sent, `<connection>/<tool>`. */
  id: string;
  outcome: McpCallOutcome;
  /** What was sent to the server, exactly as the model gave it. */
  arguments: JsonObject;
  /** The `mcp_calls` row, which holds the full reply; null when nothing was sent. */
  recordId: string | null;
  /** Set on every outcome but `answered`; the app words a failed row from it. */
  code?: McpFailureCode;
  message?: string;
  /** Milliseconds the server took, when it was called. */
  ms?: number;
  /**
   * What the model read of the reply: its text after the long-reply cut, with `cut` true when it
   * was cut, and the stored media parts. Absent when the call has no reply (`unreachable`,
   * `aborted`, `too_large`, `unknown_tool`, `connection_removed`). The full reply is in the
   * record.
   */
  reply?: { text: string; cut: boolean; media?: StoredMediaPart[] };
}

export interface McpDescribedItem {
  /** What the model asked for. */
  name: string;
  /** A tool described, a connection's tools listed, or a name the thread does not hold. */
  kind: "tool" | "connection" | "unknown";
  connection: string | null;
  /** Set for `kind: "tool"`. */
  tool: string | null;
  /** Set for `kind: "connection"`: its tools' names. */
  tools?: string[];
}

export interface McpDescribeResult {
  items: McpDescribedItem[];
  /** What the model read: each tool's description and schema, or each connection's tool lines. */
  text: string;
}
