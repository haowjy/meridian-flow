/**
 * Server adapter for the shared context URI parser. Domain callers keep the
 * context-port error vocabulary while contracts owns normalization semantics.
 */
import {
  canonicalContextUri,
  formatParsedContextUri,
  type ParseContextUriOptions,
  type ParsedContextUri,
  parseContextUri as parseSharedContextUri,
  UNIFIED_CONTEXT_SCHEMES,
} from "@meridian/contracts/context-uri";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextError } from "../ports/context-port.js";

export type { ParseContextUriOptions, ParsedContextUri };
export { canonicalContextUri as toCanonical, UNIFIED_CONTEXT_SCHEMES };

export function parseContextUri(
  raw: string,
  options: ParseContextUriOptions = {},
): Result<ParsedContextUri, ContextError> {
  const parsed = parseSharedContextUri(raw, options);
  return parsed.ok ? Ok(parsed.value) : Err({ code: "invalid_uri", ...parsed.error });
}

export function parseUnifiedContextUri(raw: string): Result<ParsedContextUri, ContextError> {
  return parseContextUri(raw, {
    barePathDefault: "manuscript",
    schemes: UNIFIED_CONTEXT_SCHEMES,
  });
}

/**
 * The root of the area `uri` is in (its scheme and owner): where a move or delete is aimed,
 * naming no entry. An address that does not parse stays as it is, for the port to refuse.
 */
export function contextAreaOf(uri: string): string {
  const parsed = parseUnifiedContextUri(uri);
  return parsed.ok ? formatParsedContextUri(parsed.value.scheme, "", parsed.value.authority) : uri;
}
