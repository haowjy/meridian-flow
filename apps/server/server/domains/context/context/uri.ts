import {
  formatParsedContextUri,
  type ParseContextUriOptions,
  type ParsedContextUri,
  parseContextUri,
  UNIFIED_CONTEXT_SCHEMES,
} from "@meridian/contracts/context-uri";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextError } from "../ports/context-port.js";

export type { ParseContextUriOptions, ParsedContextUri };
export { UNIFIED_CONTEXT_SCHEMES };

export function parseContextUriResult(
  raw: string,
  options: ParseContextUriOptions = {},
): Result<ParsedContextUri, ContextError> {
  const parsed = parseContextUri(raw, options);
  return parsed.ok ? Ok(parsed.value) : Err({ code: "invalid_uri", ...parsed.error });
}

export function parseUnifiedContextUriResult(raw: string): Result<ParsedContextUri, ContextError> {
  return parseContextUriResult(raw, {
    barePathDefault: "manuscript",
    schemes: UNIFIED_CONTEXT_SCHEMES,
  });
}

export function contextAreaOf(uri: string): string {
  const parsed = parseUnifiedContextUriResult(uri);
  return parsed.ok ? formatParsedContextUri(parsed.value.scheme, "", parsed.value.authority) : uri;
}
