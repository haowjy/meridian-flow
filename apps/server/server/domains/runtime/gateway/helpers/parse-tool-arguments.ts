/**
 * Repairs provider tool-call argument JSON when an LLM emits malformed object
 * text. OpenAI-compatible models sometimes produce bare unquoted hash-like
 * tokens (for example `"in": 6c4a`); repair confidently fixable JSON, and
 * otherwise return an explicit typed parse failure so callers can keep parsed
 * arguments separate from model-facing error reporting.
 */
import { jsonrepair } from "jsonrepair";

export type ParsedToolArgs =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; raw: string; message: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseError(raw: string, message: string): ParsedToolArgs {
  return { ok: false, raw, message };
}

export function parseToolCallArguments(raw: string | undefined): ParsedToolArgs {
  if (!raw) return { ok: true, arguments: {} };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isJsonObject(parsed)) return { ok: true, arguments: parsed };
    return parseError(raw, "Tool arguments must be a JSON object");
  } catch (strictError) {
    try {
      const repaired = JSON.parse(jsonrepair(raw)) as unknown;
      if (isJsonObject(repaired)) return { ok: true, arguments: repaired };
      return parseError(raw, "Tool arguments must be a JSON object");
    } catch (repairError) {
      return parseError(raw, messageFromError(repairError) || messageFromError(strictError));
    }
  }
}
