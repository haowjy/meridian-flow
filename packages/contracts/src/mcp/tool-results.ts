/** The typed `result` of the three connection tools, which the chat rows read. */
import type { JsonObject, JsonValue, StoredMediaPart } from "../threads/index.js";

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
  /**
   * The tool's description and input schema, set when the tool reported a problem or the server
   * refused. The model reads it after the server's words; the row does not show it.
   */
  schema?: string;
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

/** One call a script made: the `mcp_call` shape with the call's place in the script. */
export type McpScriptCall = McpCallResult & { sequence: number };

/**
 * How a script ended. `rejected_code` is code the type stripper could not parse (nothing ran);
 * `unavailable` is the runner failing to start or dying under the script.
 */
export type McpRunEnded =
  | "returned"
  | "threw"
  | "timed_out"
  | "too_large"
  | "aborted"
  | "unavailable"
  | "rejected_code";

/** The typed `result` of `mcp_run`, which the script row reads. */
export interface McpRunResult {
  ended: McpRunEnded;
  /** The JSON the script returned; set for `returned`, absent when it returned nothing. */
  value?: JsonValue;
  /** `threw`, `rejected_code` and `unavailable`: the failure in the runner's or stripper's words. */
  error?: { name: string; message: string; line?: number; column?: number };
  /** `timed_out`: which limit, and how long it is. */
  limit?: "wall" | "cpu";
  limitMs?: number;
  /** `too_large`: the size the value had. */
  bytes?: number;
  /** In the order the script made them. A reply is cut to what the row shows; the record has it whole. */
  calls: McpScriptCall[];
  logs?: { text: string; cutBytes: number };
  /** What the model read: the value, then the calls, then the logs, in Flow's words. */
  text: string;
}
