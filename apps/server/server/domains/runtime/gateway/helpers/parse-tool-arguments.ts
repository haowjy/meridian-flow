/**
 * Repairs provider tool-call argument JSON when an LLM emits malformed object
 * text. OpenAI-compatible models sometimes produce bare unquoted hash-like
 * tokens (for example `"in": 6c4a`); repair confidently fixable JSON, and
 * otherwise surface a typed parse error instead of degrading into misleading
 * downstream schema errors such as "path is required".
 */
import { jsonrepair } from "jsonrepair";

export const TOOL_ARGS_PARSE_ERROR = "__meridianToolArgsParseError";

export interface ToolArgsParseError extends Record<string, unknown> {
  [TOOL_ARGS_PARSE_ERROR]: { raw: string; message: string };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseError(raw: string, message: string): ToolArgsParseError {
  return { [TOOL_ARGS_PARSE_ERROR]: { raw, message } };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isToolArgsParseError(value: unknown): value is ToolArgsParseError {
  return (
    isJsonObject(value) &&
    TOOL_ARGS_PARSE_ERROR in value &&
    isJsonObject(value[TOOL_ARGS_PARSE_ERROR]) &&
    typeof value[TOOL_ARGS_PARSE_ERROR].raw === "string" &&
    typeof value[TOOL_ARGS_PARSE_ERROR].message === "string"
  );
}

export function parseToolCallArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isJsonObject(parsed)) return parsed;
    return parseError(raw, "Tool arguments must be a JSON object");
  } catch (strictError) {
    try {
      const repaired = JSON.parse(jsonrepair(raw)) as unknown;
      if (isJsonObject(repaired)) return repaired;
      return parseError(raw, "Tool arguments must be a JSON object");
    } catch (repairError) {
      return parseError(raw, messageFromError(repairError) || messageFromError(strictError));
    }
  }
}
