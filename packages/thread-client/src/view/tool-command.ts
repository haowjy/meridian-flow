/** Maps tool views to writer-facing commands and labels. */
import { type SaveOutcome, saveOutcomeSchema } from "@meridian/contracts/agents";
import type { McpCallResult, McpDescribeResult, McpRunResult } from "@meridian/contracts/mcp";
import { isDoneWriteStatus, type JsonValue } from "@meridian/contracts/protocol";
import { parseWorkReceipt, type WorkReceipt } from "@meridian/contracts/works";
import type { ToolView } from "./group-delivery-segments";

export type ToolCommand =
  | "read"
  | "skim"
  | "create"
  | "copy"
  | "move"
  | "delete"
  | "edit"
  | "undo"
  | "redo"
  | "grep"
  | "list"
  | "skill"
  | "work-read"
  | "work-create"
  | "work-update"
  | "work-delete"
  | "work-switch"
  | "save-agents"
  | "mcp-describe"
  | "mcp-call"
  | "mcp-run"
  | "unknown";

export function toolCommand(tool: ToolView): ToolCommand {
  switch (tool.toolName) {
    case "read":
      return stringInput(toolInputObject(tool), "format") === "outline" ? "skim" : "read";
    case "write":
      return writeCommand(toolInputObject(tool));
    case "grep":
      return "grep";
    case "ls":
      return "list";
    case "skill":
      return "skill";
    case "work":
      return workToolCommand(tool);
    case "save_agents":
      return "save-agents";
    case "mcp_describe":
      return "mcp-describe";
    case "mcp_call":
      return "mcp-call";
    case "mcp_run":
      return "mcp-run";
    default:
      return "unknown";
  }
}

/** The server's facts for one `work` mutation (Work names before and after, never handles) and the inverse that would undo it; the app writes the line from them. */
export type { WorkReceipt } from "@meridian/contracts/works";

export function workReceipt(tool: ToolView): WorkReceipt | null {
  return parseWorkReceipt(tool.metadata?.workReceipt);
}

/** One outcome per package a `save_agents` call saved or failed to save (set by the server on the result). */
export function agentsSaved(tool: ToolView): SaveOutcome[] {
  const outcomes = tool.metadata?.agentsSaved;
  if (!Array.isArray(outcomes)) return [];
  return outcomes.flatMap((outcome) => {
    const parsed = saveOutcomeSchema.safeParse(outcome);
    return parsed.success ? [parsed.data] : [];
  });
}

/** One `mcp_call`, from its typed result once it ends and from its input while it runs. */
export type McpCallView = {
  /** The connection's name and the server's tool name; null until the model has named them. */
  connection: string | null;
  tool: string | null;
  /** What was sent; null while the arguments are still streaming in. */
  arguments: Record<string, JsonValue> | null;
  /** Null while the call runs. */
  result: McpCallResult | null;
};

/** A call that ended any way but `answered` failed, whatever the transport said. */
export function mcpCallFailed(tool: ToolView): boolean {
  if (tool.isError) return true;
  const outcome = mcpCallResult(tool.result)?.outcome;
  return outcome !== undefined && outcome !== "answered";
}

export function mcpCall(tool: ToolView): McpCallView {
  const result = mcpCallResult(tool.result);
  const input = toolInputObject(tool);
  const [connection, name] = splitMcpToolId(stringInput(input, "tool"));
  const sent = input.arguments;
  return {
    connection: result?.connection ?? connection,
    tool: result?.tool ?? name,
    arguments:
      (result?.arguments as Record<string, JsonValue> | undefined) ??
      (sent && typeof sent === "object" && !Array.isArray(sent) ? sent : null),
    result,
  };
}

/** One `mcp_run`: its code, its typed result once it ends, and a row per call, live while it runs. */
export type McpRunView = {
  code: string | null;
  /** Null while the script runs. */
  result: McpRunResult | null;
  /** Each call as an `mcp_call` view, so the call's row is the one `mcp_call` has. */
  calls: ToolView[];
};

/** A script that ended any way but `returned` failed, whatever the transport said. */
export function mcpRunFailed(tool: ToolView): boolean {
  if (tool.isError) return true;
  const result = mcpRunResult(tool.result);
  return result !== null && result.ended !== "returned";
}

export function mcpRun(tool: ToolView): McpRunView {
  const result = mcpRunResult(tool.result);
  const code = toolInputObject(tool).code;
  // The result lists every call; while the script runs, the calls it has made come from the live events.
  const entries: {
    sequence: number;
    id: string;
    arguments: JsonValue;
    call: McpCallResult | null;
  }[] = result
    ? result.calls.map((call) => ({
        sequence: call.sequence,
        id: call.id,
        arguments: call.arguments,
        call,
      }))
    : (tool.connectionCalls ?? []).flatMap((live) => {
        const entry = live as {
          sequence?: number;
          id?: string;
          arguments?: JsonValue;
          call?: McpCallResult;
        };
        return typeof entry.sequence === "number" && typeof entry.id === "string"
          ? [
              {
                sequence: entry.sequence,
                id: entry.id,
                arguments: entry.arguments ?? {},
                call: entry.call ?? null,
              },
            ]
          : [];
      });
  return {
    code: typeof code === "string" ? code : null,
    result,
    calls: entries.map((entry) => ({
      toolCallId: `${tool.toolCallId}#${entry.sequence}`,
      toolName: "mcp_call",
      input: { tool: entry.id, arguments: entry.arguments },
      result: entry.call as unknown as JsonValue | null,
      status: entry.call ? "complete" : "partial",
      isError: entry.call ? entry.call.outcome !== "answered" : false,
      message: null,
      streamedOutput: null,
      connectionCalls: null,
      metadata: null,
      keyBlock: tool.keyBlock,
    })),
  };
}

function mcpRunResult(value: JsonValue | null): McpRunResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.ended === "string" && Array.isArray(value.calls)
    ? (value as unknown as McpRunResult)
    : null;
}

function mcpCallResult(value: JsonValue | null): McpCallResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.outcome === "string" && typeof value.id === "string"
    ? (value as unknown as McpCallResult)
    : null;
}

/** `<connection>/<tool>`, split at the first `/`; a bare name is a connection. */
function splitMcpToolId(id: string | undefined): [string | null, string | null] {
  if (!id) return [null, null];
  const at = id.indexOf("/");
  return at < 0 ? [id, null] : [id.slice(0, at), id.slice(at + 1) || null];
}

/** What one `mcp_describe` asked for: tool ids and connection names, with what each turned out to be once it ends. */
export function mcpDescribed(tool: ToolView): {
  connection: string | null;
  tool: string | null;
  kind: "tool" | "connection" | "unknown" | null;
}[] {
  const result = tool.result as McpDescribeResult | null;
  if (result && typeof result === "object" && Array.isArray(result.items))
    return result.items.map((item) => ({
      connection: item.connection,
      tool: item.tool,
      kind: item.kind,
    }));
  const asked = toolInputObject(tool).tools;
  if (!Array.isArray(asked)) return [];
  return asked.flatMap((id) => {
    if (typeof id !== "string") return [];
    const [connection, name] = splitMcpToolId(id);
    return [{ connection, tool: name, kind: null }];
  });
}

function workToolCommand(tool: ToolView): ToolCommand {
  // The receipt is the server's record of what changed, so its operation wins;
  // a result-only view has no input to classify from.
  const command = workReceipt(tool)?.operation ?? stringInput(toolInputObject(tool), "command");
  switch (command) {
    case "list":
    case "show":
      return "work-read";
    case "switch":
      return "work-switch";
    case "create":
      return "work-create";
    case "update":
      return "work-update";
    case "delete":
      return "work-delete";
    default:
      return "unknown";
  }
}

/**
 * The writer-facing verb for one `write` call. Removing blocks is an edit. A
 * `copy`, or an `insert`/`replace` that takes its blocks from `from`, is a copy:
 * saying it wrote text would hide where the words came from. `move` and
 * `delete` change where a whole document is, not what it says. A call whose
 * command hasn't streamed in yet reads as writing; a command this list doesn't
 * know is `unknown`.
 */
function writeCommand(input: Record<string, JsonValue>): ToolCommand {
  const command = stringInput(input, "command");
  switch (command) {
    case "create":
      return "create";
    case "copy":
      return "copy";
    case "move":
      return "move";
    case "delete":
      return "delete";
    case "insert":
    case "replace":
      return sourcePath(input) ? "copy" : "edit";
    case "remove":
      return "edit";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    default:
      return command ? "unknown" : "create";
  }
}

/** The document a `write` call takes from, as the model named it (`from.path`): a copy's source, or the document a move moves. */
export function sourcePath(input: Record<string, JsonValue>): string | undefined {
  const from = input.from;
  if (!from || typeof from !== "object" || Array.isArray(from)) return undefined;
  return stringInput(from as Record<string, JsonValue>, "path");
}

export function toolInputObject(tool: ToolView): Record<string, JsonValue> {
  const raw = tool.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, JsonValue>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, JsonValue>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function stringInput(input: Record<string, JsonValue>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A file inside a skill package: `skills://<skill>/<path>`. */
type SkillFile = { skill: string; path: string };

/**
 * The skill a `skills://` path belongs to, and the file's path inside it.
 * `skills://` addresses no writer document, so it never parses as a context URI.
 */
export function skillFile(path: string): SkillFile | null {
  const match = path.trim().match(/^skills:\/\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { skill: match[1], path: match[2] };
}

export function humanizeSkillSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Domain refusals are failed document operations even when transport succeeded. */
export function documentToolFailed(tool: ToolView): boolean {
  if (tool.isError) return true;
  if (tool.status !== "complete" || (tool.toolName !== "write" && tool.toolName !== "read"))
    return false;
  const result = tool.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  return typeof result.status === "string" && !isDoneWriteStatus(result.status);
}

/**
 * A write the document's state returned: nothing was kept and the AI carries on. It is a settled
 * outcome, not a failure, even though it takes the failed row's explanation.
 */
export function documentToolReturned(tool: ToolView): boolean {
  if (tool.isError || tool.status !== "complete" || tool.toolName !== "write") return false;
  const result = tool.result;
  return (
    !!result && typeof result === "object" && !Array.isArray(result) && result.status === "returned"
  );
}
