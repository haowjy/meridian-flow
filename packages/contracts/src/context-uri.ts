/** Shared syntax parser, stable serializer, and presentation-neutral context URI derivations. */

import { parseDocumentFilename, renderFilename } from "./protocol/document-filename.js";
import type { ResolvedWorkAuthority, WorkSlug } from "./works/index.js";
import { decodeWorkSlug } from "./works/index.js";

export const CONTEXT_URI_SCHEMES = [
  "manuscript",
  "kb",
  "user",
  "unfiled",
  "scratch",
  "uploads",
] as const;
export type ContextUriScheme = (typeof CONTEXT_URI_SCHEMES)[number];

/** Sources whose agent writes go to a draft-mode Work's draft (D9, D11). */
export function isDraftedScheme(scheme: ContextUriScheme): boolean {
  return scheme === "manuscript" || scheme === "kb" || scheme === "user" || scheme === "unfiled";
}

export const PROJECT_SCOPED_CONTEXT_URI_SCHEMES = ["manuscript", "kb", "user", "unfiled"] as const;
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
  | { kind: "lineage"; rootThreadRef: string }
  /** The chat (a primary thread) that received the files; only `uploads://` takes it. */
  | { kind: "chat"; chatRef: string }
  | { kind: "work"; workSlug: WorkSlug };

/** The owners a holder's authority supplies, independently for each owned scheme. */
export function holderAuthorities(
  authority: ParsedContextAuthority,
): Record<WorkScopedContextUriScheme, ParsedContextAuthority | null> {
  switch (authority.kind) {
    case "work":
      return { scratch: authority, uploads: null };
    case "lineage":
      return { scratch: authority, uploads: null };
    case "chat":
      return { scratch: null, uploads: authority };
    case "none":
      return { scratch: null, uploads: null };
    case "contextual":
      return { scratch: null, uploads: null };
  }
}

/** Qualify a contextual address only when its holder supplies that scheme's owner. */
export function qualifyContextUriByHolder(uri: string, holderUri: string | null): string {
  const target = parseContextUri(uri);
  const holder = holderUri ? parseContextUri(holderUri) : null;
  if (!target.ok || target.value.authority.kind !== "contextual" || !holder?.ok) return uri;
  if (isProjectScopedScheme(target.value.scheme)) return uri;
  const authority = holderAuthorities(holder.value.authority)[target.value.scheme];
  return authority
    ? formatParsedContextUri(target.value.scheme, target.value.path, authority)
    : uri;
}

/** Authority accepted by stable URI serialization. */
export type CanonicalContextAuthority =
  | { kind: "contextual" }
  | { kind: "none" }
  | { kind: "lineage"; rootThreadRef: string }
  | { kind: "chat"; chatRef: string }
  | ResolvedWorkAuthority;

export interface ParsedContextUri {
  scheme: ContextUriScheme;
  authority: ParsedContextAuthority;
  /** Normalized path: no edge slash, empty or `.` segments, or repeated slashes. */
  path: string;
  /** Grammar-normalized syntax. Real-Work identity is not resolved yet. */
  normalized: string;
}

type ContextUriParseError = {
  ok: false;
  /** `unknownScheme` marks a URI that names no context scheme, so it addresses no document. */
  error: { uri: string; reason: string; unknownScheme?: string };
};
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
  if (isProjectScopedScheme(scheme) && !("kind" in authority && authority.kind === "contextual")) {
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
  if (scheme !== "scratch" && "kind" in authority && authority.kind === "lineage") {
    throw new RangeError("Only Scratch supports a first-chat qualifier");
  }
  if (scheme !== "uploads" && "kind" in authority && authority.kind === "chat") {
    throw new RangeError("Only uploads support a chat qualifier");
  }
  if (scheme === "scratch" && normalizedPath && authorityQualifier(authority) === "@") {
    throw new RangeError(missingScratchHandle);
  }
  if (scheme === "uploads" && normalizedPath && authorityQualifier(authority) === "@") {
    throw new RangeError(missingUploadsHandle);
  }
  const qualifier = authorityQualifier(authority);
  if (qualifier)
    return normalizedPath
      ? `${scheme}://${qualifier}/${normalizedPath}`
      : `${scheme}://${qualifier}/`;
  return normalizedPath ? `${scheme}://${normalizedPath}` : `${scheme}://`;
}

function authorityQualifier(authority: CanonicalContextAuthority): string | null {
  if ("kind" in authority && authority.kind === "lineage") {
    if (!/^c[1-9][0-9]*$/.test(authority.rootThreadRef))
      throw new RangeError("Invalid first-chat handle");
    return `@/${authority.rootThreadRef}`;
  }
  if ("kind" in authority && authority.kind === "chat") {
    if (!/^c[1-9][0-9]*$/.test(authority.chatRef)) throw new RangeError("Invalid chat handle");
    return `@/${authority.chatRef}`;
  }
  if ("workSlug" in authority) return authority.workSlug ? `@${authority.workSlug}` : "@";
  return authority.kind === "none" ? "@" : null;
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
      return {
        ok: false,
        error: {
          uri: raw,
          reason: `Unknown scheme "${parsedScheme}". Known schemes: ${schemes.map((known) => `${known}://`).join(", ")}`,
          unknownScheme: parsedScheme,
        },
      };
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
  if (qualifier === "@" && scheme === "scratch" && segments.length) {
    const rootThreadRef = segments.shift() ?? "";
    if (!/^c[1-9][0-9]*$/.test(rootThreadRef))
      return invalidContextUri(rawUri, missingScratchHandle);
    return {
      ok: true,
      value: { authority: { kind: "lineage", rootThreadRef }, rawPath: segments.join("/") },
    };
  }
  if (qualifier === "@" && scheme === "uploads" && segments.length) {
    const chatRef = segments.shift() ?? "";
    if (/^p[1-9][0-9]*$/.test(chatRef)) {
      return invalidContextUri(rawUri, "Use the chat's handle (c…), not a subagent's (p…).");
    }
    if (!/^c[1-9][0-9]*$/.test(chatRef)) return invalidContextUri(rawUri, missingUploadsHandle);
    return {
      ok: true,
      value: { authority: { kind: "chat", chatRef }, rawPath: segments.join("/") },
    };
  }
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

/** Schemes whose documents belong to the project (or, for `user://`, the user), never to a Work. */
export function isProjectScopedScheme(
  scheme: ContextUriScheme,
): scheme is ProjectScopedContextUriScheme {
  return (PROJECT_SCOPED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
}

/** Spell parsed address syntax; this does not resolve or grant Work authority. */
export function formatParsedContextUri(
  scheme: ContextUriScheme,
  path: string,
  authority: ParsedContextAuthority,
): string {
  const qualifier =
    authority.kind === "lineage"
      ? `@/${authority.rootThreadRef}`
      : authority.kind === "chat"
        ? `@/${authority.chatRef}`
        : authority.kind === "work"
          ? `@${authority.workSlug}`
          : authority.kind === "none"
            ? "@"
            : null;
  if (qualifier) return path ? `${scheme}://${qualifier}/${path}` : `${scheme}://${qualifier}/`;
  return path ? `${scheme}://${path}` : `${scheme}://`;
}

function invalidContextUri(uri: string, reason: string): ContextUriParseError {
  return { ok: false, error: { uri, reason } };
}

/** Split an href at its first `?` or `#`: the path, and the suffix every spelling keeps. */
export function splitDocumentHrefSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index < 0
    ? { path: value, suffix: "" }
    : { path: value.slice(0, index), suffix: value.slice(index) };
}

/**
 * The name a writer sees for the document at the final URI/path segment: the
 * stored name as the codec spells it. A stored segment is already canonical
 * (`Chapter 13`, `outline.json`, `Vol. 2`); a segment someone typed is
 * canonicalized (`ch12.md` and `notes.txt` read `ch12` and `notes`). No
 * extension is stripped on its own.
 *
 * This accepts decoded addresses, not hrefs. Href/tool callers split suffixes
 * before decoding at their boundary.
 *
 * Callers own the fallback because some server notices prefer a document id
 * while writer-facing surfaces use "Untitled document".
 */
export function documentTitleFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const schemeSeparator = uri.indexOf("://");
  const path = schemeSeparator >= 0 ? uri.slice(schemeSeparator + 3) : uri;
  const segment = path.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  const parsed = parseDocumentFilename(segment);
  return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : segment;
}

const missingScratchHandle =
  "Scratch under @/ requires the first chat handle. Use scratch://x for this chat’s notes, or scratch://@/c12/x for a specific chat. List chats with ls scratch://@/.";

const missingUploadsHandle =
  "Uploads under @/ require the chat handle. Use uploads://x for this chat’s files, or uploads://@/c12/x for a specific chat.";
