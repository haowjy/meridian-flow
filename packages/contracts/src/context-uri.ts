/** Shared syntax parser, stable serializer, and presentation-neutral context URI derivations. */

import type { ResolvedWorkAuthority, WorkSlug } from "./works/index.js";
import { decodeWorkSlug } from "./works/index.js";

export const CONTEXT_URI_SCHEMES = ["manuscript", "kb", "user", "scratch", "uploads"] as const;
export type ContextUriScheme = (typeof CONTEXT_URI_SCHEMES)[number];

export const PROJECT_SCOPED_CONTEXT_URI_SCHEMES = ["manuscript", "kb", "user"] as const;
export type ProjectScopedContextUriScheme = (typeof PROJECT_SCOPED_CONTEXT_URI_SCHEMES)[number];

export const WORK_SCOPED_CONTEXT_URI_SCHEMES = ["scratch", "uploads"] as const;
export type WorkScopedContextUriScheme = (typeof WORK_SCOPED_CONTEXT_URI_SCHEMES)[number];

/** A URI already serialized with stable authority rather than contextual shorthand. */
export type CanonicalContextUri = string;

/** Server-declared operations available through a context scheme. */
export interface ContextSchemeCapabilities {
  readonly writable: boolean;
  readonly searchable: boolean;
  /**
   * Whether context clients may create entries or directories. Binary upload
   * intake is governed separately and may remain available when this is false.
   */
  readonly creatable: boolean;
}

/** Syntax-only authority carried by a parsed Work-capable context URI. */
export type ParsedContextAuthority =
  | { kind: "contextual" }
  | { kind: "none" }
  | { kind: "work"; workSlug: WorkSlug };

/** Authority accepted by stable URI serialization. */
export type CanonicalContextAuthority =
  | { kind: "contextual" }
  | { kind: "none" }
  | ResolvedWorkAuthority;

export interface ParsedContextUri {
  scheme: ContextUriScheme;
  authority: ParsedContextAuthority;
  /** Normalized path: no edge slash, empty or `.` segments, or repeated slashes. */
  path: string;
  /** Grammar-normalized syntax. Real-Work identity is not resolved yet. */
  normalized: string;
}

type ContextUriParseError = { ok: false; error: { uri: string; reason: string } };
export type ContextUriParseResult = { ok: true; value: ParsedContextUri } | ContextUriParseError;
type AuthorityParseResult =
  | { ok: true; value: { authority: ParsedContextAuthority; rawPath: string } }
  | ContextUriParseError;

export interface ParseContextUriOptions {
  barePathDefault?: ContextUriScheme;
  schemes?: readonly ContextUriScheme[];
}

/** Canonical string form of a parsed scheme + optional authority + path. */
export function canonicalContextUri(
  scheme: ProjectScopedContextUriScheme,
  path: string,
  authority?: Extract<CanonicalContextAuthority, { kind: "contextual" }>,
): string;
export function canonicalContextUri(
  scheme: WorkScopedContextUriScheme,
  path: string,
  authority?: CanonicalContextAuthority,
): string;
export function canonicalContextUri(
  scheme: ContextUriScheme,
  path: string,
  authority?: CanonicalContextAuthority,
): string;
export function canonicalContextUri(
  scheme: ContextUriScheme,
  path: string,
  authority: CanonicalContextAuthority = { kind: "contextual" },
): string {
  if (authority.kind !== "contextual" && isProjectScopedScheme(scheme)) {
    throw new RangeError(`Scheme "${scheme}" does not support authority qualifiers`);
  }
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new RangeError('Path traversal (".." ) is not allowed');
  }
  if (segments.some((segment) => segment.startsWith("@"))) {
    throw new RangeError('Path segments beginning with "@" are reserved');
  }
  const normalizedPath = segments.join("/");
  const qualifier =
    authority.kind === "work" ? `@${authority.workSlug}` : authority.kind === "none" ? "@" : null;
  if (qualifier)
    return normalizedPath
      ? `${scheme}://${qualifier}/${normalizedPath}`
      : `${scheme}://${qualifier}/`;
  return normalizedPath ? `${scheme}://${normalizedPath}` : `${scheme}://`;
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
  if (segments.some((segment) => segment.startsWith("@"))) {
    return invalidContextUri(raw, 'Path segments beginning with "@" are reserved');
  }

  const path = segments.join("/");
  const normalized = formatParsedContextUri(scheme, path, authorityResult.value.authority);
  return {
    ok: true,
    value: {
      scheme,
      authority: authorityResult.value.authority,
      path,
      normalized,
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
  if (!rawPath) return { ok: true, value: { authority: { kind: "contextual" }, rawPath } };

  const segments = rawPath.split("/").filter((segment) => segment !== "" && segment !== ".");
  const qualifiers: string[] = [];
  while (segments[0]?.startsWith("@")) qualifiers.push(segments.shift() ?? "");
  if (qualifiers.length === 0) {
    return { ok: true, value: { authority: { kind: "contextual" }, rawPath } };
  }
  if (qualifiers.length > 1) {
    return invalidContextUri(
      rawUri,
      `Authority qualifier chains are not yet supported for scheme "${scheme}"`,
    );
  }
  if (!(WORK_SCOPED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme)) {
    return invalidContextUri(
      rawUri,
      `Scheme "${scheme}" does not yet support authority qualifiers`,
    );
  }
  const qualifier = qualifiers[0] ?? "";
  if (qualifier === "@") {
    return { ok: true, value: { authority: { kind: "none" }, rawPath: segments.join("/") } };
  }
  const workSlug = decodeWorkSlug(qualifier.slice(1));
  if (!workSlug) {
    return invalidContextUri(rawUri, `Invalid Work slug authority "${qualifier.slice(1)}"`);
  }
  return {
    ok: true,
    value: { authority: { kind: "work", workSlug }, rawPath: segments.join("/") },
  };
}

function isProjectScopedScheme(scheme: ContextUriScheme): scheme is ProjectScopedContextUriScheme {
  return (PROJECT_SCOPED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
}

function formatParsedContextUri(
  scheme: ContextUriScheme,
  path: string,
  authority: ParsedContextAuthority,
): string {
  const qualifier =
    authority.kind === "work" ? `@${authority.workSlug}` : authority.kind === "none" ? "@" : null;
  if (qualifier) return path ? `${scheme}://${qualifier}/${path}` : `${scheme}://${qualifier}/`;
  return path ? `${scheme}://${path}` : `${scheme}://`;
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
