/**
 * Context URI parser/normalizer: validates the scheme, normalizes the path,
 * extracts Work authority for work-scoped schemes, and produces canonical form.
 * Owns the single source of truth for well-formed context URIs.
 */
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextError, ContextScheme } from "../ports/context-port.js";

const LEGACY_SCHEMES: readonly ContextScheme[] = ["fs1", "kb", "work", "user"];
const UNIFIED_SCHEMES: readonly ContextScheme[] = ["manuscript", "kb", "user", "work", "uploads"];
const AUTHORITY_SCHEMES: ReadonlySet<ContextScheme> = new Set(["work", "uploads"]);
const UUID_AUTHORITY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function looksLikeMalformedWorkAuthority(segment: string): boolean {
  if (UUID_AUTHORITY_PATTERN.test(segment)) return false;
  const dashIndex = segment.indexOf("-");
  if (dashIndex === -1) return false;
  const firstGroup = segment.slice(0, dashIndex);
  return /^[0-9a-f]{4,}$/i.test(firstGroup);
}

export interface ParsedContextUri {
  scheme: ContextScheme;
  /** Work ID from the URI authority for work-scoped schemes, or null for bare URIs. */
  authority: string | null;
  /** Normalized path: no leading/trailing slash, no `.`/`..`, slashes collapsed. */
  path: string;
  /** Canonical string form. */
  canonical: string;
}

export interface ParseContextUriOptions {
  /** Bare-path default when no `scheme://` prefix is present. */
  barePathDefault?: ContextScheme;
  /** Allowed schemes for this parse context. */
  schemes?: readonly ContextScheme[];
}

function isContextScheme(s: string, schemes: readonly ContextScheme[]): s is ContextScheme {
  return (schemes as readonly string[]).includes(s);
}

/** Canonical string form of a parsed scheme + optional authority + path. */
export function toCanonical(
  scheme: ContextScheme,
  path: string,
  authority: string | null = null,
): string {
  if (authority) {
    return path ? `${scheme}://${authority}/${path}` : `${scheme}://${authority}`;
  }
  return path ? `${scheme}://${path}` : `${scheme}://`;
}

function parseAuthorityPrefix(
  scheme: ContextScheme,
  rawPath: string,
  rawUri: string,
): Result<{ authority: string | null; rawPath: string }, ContextError> {
  if (!rawPath || rawPath.startsWith("/")) {
    return Ok({ authority: null, rawPath });
  }

  const [firstSegment = "", ...remainingSegments] = rawPath.split("/");
  if (!UUID_AUTHORITY_PATTERN.test(firstSegment)) {
    if (
      AUTHORITY_SCHEMES.has(scheme) &&
      remainingSegments.length > 0 &&
      looksLikeMalformedWorkAuthority(firstSegment)
    ) {
      return Err({
        code: "invalid_uri",
        uri: rawUri,
        reason: `Invalid Work authority "${firstSegment}"`,
      });
    }
    return Ok({ authority: null, rawPath });
  }

  if (!AUTHORITY_SCHEMES.has(scheme)) {
    return Err({
      code: "invalid_uri",
      uri: rawUri,
      reason: `Scheme "${scheme}" does not support Work authority`,
    });
  }

  return Ok({ authority: firstSegment, rawPath: remainingSegments.join("/") });
}

/**
 * Parse a context URI. Strict serializer, lenient parser.
 *
 * Legacy default: bare paths → `fs1://`.
 * Unified default (pass `{ barePathDefault: "manuscript" }`): bare paths → `manuscript://`.
 */
export function parseContextUri(
  raw: string,
  options: ParseContextUriOptions = {},
): Result<ParsedContextUri, ContextError> {
  const schemes = options.schemes ?? LEGACY_SCHEMES;
  const bareDefault = options.barePathDefault ?? "fs1";

  const trimmed = raw.trim();
  if (!trimmed) {
    return Err({ code: "invalid_uri", uri: raw, reason: "Empty URI" });
  }

  let scheme: ContextScheme;
  let rawPath: string;
  let authority: string | null = null;

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/{2}(.*)$/);
  if (schemeMatch) {
    const parsedScheme = schemeMatch[1];
    if (!isContextScheme(parsedScheme, schemes)) {
      return Err({
        code: "invalid_uri",
        uri: raw,
        reason: `Unknown scheme "${parsedScheme}"`,
      });
    }
    scheme = parsedScheme;
    rawPath = schemeMatch[2];
  } else if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) {
    return Err({
      code: "invalid_uri",
      uri: raw,
      reason: 'Malformed URI: expected "scheme://path"',
    });
  } else {
    scheme = bareDefault;
    rawPath = trimmed;
  }

  const authorityResult = parseAuthorityPrefix(scheme, rawPath, raw);
  if (!authorityResult.ok) {
    return authorityResult;
  }
  authority = authorityResult.value.authority;
  rawPath = authorityResult.value.rawPath;

  const segments = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");

  if (segments.includes("..")) {
    return Err({
      code: "invalid_uri",
      uri: raw,
      reason: 'Path traversal (".." ) is not allowed',
    });
  }

  const path = segments.join("/");
  return Ok({ scheme, authority, path, canonical: toCanonical(scheme, path, authority) });
}

/** Parse URIs for the unified context port vocabulary. */
export function parseUnifiedContextUri(raw: string): Result<ParsedContextUri, ContextError> {
  return parseContextUri(raw, { barePathDefault: "manuscript", schemes: UNIFIED_SCHEMES });
}

export const UNIFIED_CONTEXT_SCHEMES = UNIFIED_SCHEMES;
