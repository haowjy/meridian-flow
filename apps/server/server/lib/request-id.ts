/** HTTP request-ID parsing helpers over the server's canonical UUID wire grammar. */

import { createError } from "nitro/h3";
import { type ParsedRequestId, parseRequestId } from "./uuid.js";

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
