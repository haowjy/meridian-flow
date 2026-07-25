/** Shared parser, canonicalizer, and presentation-neutral derivations for context URIs. */

import { parseRequestId } from "./request-id.js";

export const CONTEXT_URI_SCHEMES = ["manuscript", "kb", "user", "scratch", "uploads"] as const;
export type ContextUriScheme = (typeof CONTEXT_URI_SCHEMES)[number];

export const PROJECT_SCOPED_CONTEXT_URI_SCHEMES = ["manuscript", "kb", "user"] as const;
export type ProjectScopedContextUriScheme = (typeof PROJECT_SCOPED_CONTEXT_URI_SCHEMES)[number];

export const WORK_SCOPED_CONTEXT_URI_SCHEMES = ["scratch", "uploads"] as const;
export type WorkScopedContextUriScheme = (typeof WORK_SCOPED_CONTEXT_URI_SCHEMES)[number];

const AUTHORITY_SCHEMES: ReadonlySet<ContextUriScheme> = new Set(WORK_SCOPED_CONTEXT_URI_SCHEMES);
// Full UUID *shape* (8-4-4-4-12 alphanumeric groups) regardless of hex/version
// validity — used to tell a typo'd Work id from a legitimate short folder name.
const UUID_SHAPE_PATTERN = /^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/i;

export interface ParsedContextUri {
  scheme: ContextUriScheme;
  authority: string | null;
  /** Normalized path: no edge slash, empty or `.` segments, or repeated slashes. */
  path: string;
  canonical: string;
}

type ContextUriParseError = { ok: false; error: { uri: string; reason: string } };
export type ContextUriParseResult = { ok: true; value: ParsedContextUri } | ContextUriParseError;
type AuthorityParseResult =
  | { ok: true; value: { authority: string | null; rawPath: string } }
  | ContextUriParseError;

export interface ParseContextUriOptions {
  barePathDefault?: ContextUriScheme;
  schemes?: readonly ContextUriScheme[];
}

/** Canonical string form of a parsed scheme + optional authority + path. */
export function canonicalContextUri(
  scheme: ContextUriScheme,
  path: string,
  authority: string | null = null,
): string {
  if (authority) {
    return path ? `${scheme}://${authority}/${path}` : `${scheme}://${authority}`;
  }
  return path ? `${scheme}://${path}` : `${scheme}://`;
}

/** Strict serializer, lenient parser; bare paths resolve to `manuscript://`. */
export function parseContextUri(
  raw: string,
  options: ParseContextUriOptions = {},
): ContextUriParseResult {
  const schemes = options.schemes ?? CONTEXT_URI_SCHEMES;
  const bareDefault = options.barePathDefault ?? "manuscript";
  const trimmed = raw.trim();
  if (!trimmed) return invalidContextUri(raw, "Empty URI");

  let scheme: ContextUriScheme;
  let rawPath: string;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/{2}(.*)$/);
  if (schemeMatch) {
    const parsedScheme = schemeMatch[1] ?? "";
    if (!isContextScheme(parsedScheme, schemes)) {
      return invalidContextUri(raw, `Unknown scheme "${parsedScheme}"`);
    }
    scheme = parsedScheme;
    rawPath = schemeMatch[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) {
    return invalidContextUri(raw, 'Malformed URI: expected "scheme://path"');
  } else {
    scheme = bareDefault;
    rawPath = trimmed;
  }

  const authorityResult = parseAuthorityPrefix(scheme, rawPath, raw);
  if (!authorityResult.ok) return authorityResult;

  const segments = authorityResult.value.rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    return invalidContextUri(raw, 'Path traversal (".." ) is not allowed');
  }

  const path = segments.join("/");
  return {
    ok: true,
    value: {
      scheme,
      authority: authorityResult.value.authority,
      path,
      canonical: canonicalContextUri(scheme, path, authorityResult.value.authority),
    },
  };
}

export function parseUnifiedContextUri(raw: string): ContextUriParseResult {
  return parseContextUri(raw, {
    barePathDefault: "manuscript",
    schemes: CONTEXT_URI_SCHEMES,
  });
}

export const UNIFIED_CONTEXT_SCHEMES = CONTEXT_URI_SCHEMES;

export function isContextUriScheme(value: unknown): value is ContextUriScheme {
  return typeof value === "string" && (CONTEXT_URI_SCHEMES as readonly string[]).includes(value);
}

function isContextScheme(
  scheme: string,
  schemes: readonly ContextUriScheme[],
): scheme is ContextUriScheme {
  return (schemes as readonly string[]).includes(scheme);
}

function parseAuthorityPrefix(
  scheme: ContextUriScheme,
  rawPath: string,
  rawUri: string,
): AuthorityParseResult {
  if (!rawPath || rawPath.startsWith("/")) return { ok: true, value: { authority: null, rawPath } };

  const [firstSegment = "", ...remainingSegments] = rawPath.split("/");
  const authority = parseRequestId(firstSegment);
  if (!authority) {
    // Reject only segments with the full UUID shape that fail the wire grammar
    // (a real mistyped Work id). Short folder names like "2024-assets" are not
    // UUID-shaped and parse as ordinary path segments.
    if (
      AUTHORITY_SCHEMES.has(scheme) &&
      remainingSegments.length > 0 &&
      UUID_SHAPE_PATTERN.test(firstSegment)
    ) {
      return invalidContextUri(rawUri, `Invalid Work authority "${firstSegment}"`);
    }
    return { ok: true, value: { authority: null, rawPath } };
  }
  if (!AUTHORITY_SCHEMES.has(scheme)) {
    return invalidContextUri(rawUri, `Scheme "${scheme}" does not support Work authority`);
  }
  return {
    ok: true,
    value: { authority, rawPath: remainingSegments.join("/") },
  };
}

function invalidContextUri(uri: string, reason: string): ContextUriParseError {
  return { ok: false, error: { uri, reason } };
}

/**
 * Derives a document title from the final URI/path segment.
 *
 * Context documents use the basename stem as their title. Callers own the
 * fallback because some server notices prefer a document id while writer-facing
 * surfaces use "Untitled document".
 */
export function documentTitleFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const schemeSeparator = uri.indexOf("://");
  const path = schemeSeparator >= 0 ? uri.slice(schemeSeparator + 3) : uri;
  const segment = path.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  return segment.replace(/\.[^.]+$/, "") || null;
}
