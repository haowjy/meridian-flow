import { t } from "@lingui/core/macro";
import type { McpFailureCode } from "@meridian/contracts/mcp";
import {
  meridianErrorFromStructuredToolOutput,
  TOOL_EXCEPTION_CODE,
} from "@meridian/contracts/protocol";
import type { ToolView } from "@meridian/thread-client";
import type { ToolExpand } from "./tool-renderers";

export function errorMessageExpand(tool: ToolView): ToolExpand | null {
  if (!tool.isError || tool.result == null) return null;
  const text = failureText(tool.result);
  if (!text) return null;
  return () => <div className="text-compact text-destructive">{text}</div>;
}

const INVALID_ARGUMENTS = () => t`Invalid arguments`;

export function failureText(result: NonNullable<ToolView["result"]>): string {
  const record =
    typeof result === "object" && !Array.isArray(result) ? (result as { error?: unknown }) : null;
  if (record?.error === "invalid_arguments") return INVALID_ARGUMENTS();
  if (record?.error === "permission_denied") return t`Not allowed`;
  const nested = record?.error && typeof record.error === "object" ? record.error : null;
  const error = meridianErrorFromStructuredToolOutput((nested ?? result) as typeof result);
  const mcp = mcpFailureText(error.code, record);
  if (mcp !== null) return mcp;
  switch (error.code) {
    case "tool_arguments_parse":
      return INVALID_ARGUMENTS();
    case TOOL_EXCEPTION_CODE:
      return t`Tool error`;
    case "tool_timeout":
      return t`Timed out`;
    case "thread_stopped":
      return t`Chat stopped`;
    case "one_request_at_a_time":
      return t`A question is already waiting`;
    case "permission_denied":
      return isActionDenied(error.details) ? t`Not allowed` : error.message;
    default:
      return error.message;
  }
}

function mcpFailureText(code: string, record: object | null): string | null {
  const connection = record && "connection" in record ? record.connection : null;
  const name = typeof connection === "string" ? connection : null;
  switch (code as McpFailureCode) {
    case "mcp_tool_error":
      return t`Tool error`;
    case "mcp_rejected":
      return name ? t`${name} refused it` : t`Refused`;
    case "mcp_too_large":
      return t`Reply too large`;
    case "mcp_unreachable":
      return name ? t`${name} unreachable` : t`Unreachable`;
    case "mcp_unauthorized":
      return name ? t`${name} needs sign-in` : t`Needs sign-in`;
    case "mcp_aborted":
      return t`Stopped`;
    case "mcp_unknown_tool":
      return t`Unknown tool`;
    case "mcp_connection_removed":
      return name ? t`${name} removed` : t`Connection removed`;
    default:
      return null;
  }
}

function isActionDenied(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "action_denied"
  );
}
