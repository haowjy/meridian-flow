/**
 * Server adapter for the shared context URI parser. Domain callers keep the
 * context-port error vocabulary while contracts owns normalization semantics.
 */
import {
  canonicalContextUri,
  type ParseContextUriOptions,
  type ParsedContextUri,
  parseContextUri as parseSharedContextUri,
  UNIFIED_CONTEXT_SCHEMES,
} from "@meridian/contracts/context-uri";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextError, ContextScheme } from "../ports/context-port.js";

export type { ParseContextUriOptions, ParsedContextUri };
export { canonicalContextUri as toCanonical, UNIFIED_CONTEXT_SCHEMES };

export function parseContextUri(
  raw: string,
  options: ParseContextUriOptions = {},
): Result<ParsedContextUri, ContextError> {
  const parsed = parseSharedContextUri(raw, options);
  return parsed.ok
    ? Ok(parsed.value)
    : Err({ code: "invalid_uri", uri: parsed.error.uri, reason: parsed.error.reason });
}

export function parseUnifiedContextUri(raw: string): Result<ParsedContextUri, ContextError> {
  return parseContextUri(raw, {
    barePathDefault: "manuscript",
    schemes: UNIFIED_CONTEXT_SCHEMES as readonly ContextScheme[],
  });
}
