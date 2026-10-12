/** HTTP request-ID parsing helpers over the server's canonical UUID wire grammar. */

import { type AgentSelection, agentSelectionSchema } from "@meridian/contracts/agents";
import { createError } from "nitro/h3";
import { type ParsedRequestId, parseRequestId } from "../shared/uuid.js";

export function requireRequestId(value: unknown, field: string): ParsedRequestId {
  const parsed = parseRequestId(value);
  if (parsed) return parsed;
  throw createError({ statusCode: 400, message: `\`${field}\` must be a canonical UUID` });
}

export function parseOptionalRequestId(value: unknown, field: string): ParsedRequestId | undefined {
  return value === undefined ? undefined : requireRequestId(value, field);
}

export function parseNullableRequestId(
  value: unknown,
  field: string,
): ParsedRequestId | null | undefined {
  return value === null || value === undefined ? value : requireRequestId(value, field);
}

/** The selection is transport input; both opaque identities use the normal UUID grammar. */
export function requireAgentSelection(value: unknown): AgentSelection {
  const parsed = agentSelectionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw createError({
    statusCode: 400,
    message: "`agentSelection` must contain canonical catalog and revision UUIDs",
  });
}
