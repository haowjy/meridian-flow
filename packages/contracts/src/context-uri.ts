/** Shared syntax parser, stable serializer, and presentation-neutral context URI derivations. */

import { classifyHandleToken, decodeWorkHandle, parseHandle, type WorkHandle } from "./handles.js";
import { parseDocumentFilename, renderFilename } from "./protocol/document-filename.js";
import type { ResolvedWorkAuthority } from "./works/index.js";

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

/** Schemes whose address takes an owner authority (`@w3`, `@c12`): Scratch and chat uploads. */
export const OWNED_CONTEXT_URI_SCHEMES = ["scratch", "uploads"] as const;
export type OwnedContextUriScheme = (typeof OWNED_CONTEXT_URI_SCHEMES)[number];

/** The one scheme a Work owns. Uploads belong to a chat, never to a Work. */
export type WorkScopedContextUriScheme = "scratch";

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
  /** `@` alone: a request to list the scheme's owners. */
  | { kind: "owners" }
  | { kind: "lineage"; rootThreadRef: string }
  /** The chat (a primary thread) that received the files; only `uploads://` takes it. */
  | { kind: "chat"; chatRef: string }
  | { kind: "work"; workHandle: WorkHandle };

/** The owners a holder's authority supplies, independently for each owned scheme. */
export function holderAuthorities(
  authority: ParsedContextAuthority,
): Record<OwnedContextUriScheme, ParsedContextAuthority | null> {
  switch (authority.kind) {
    case "work":
      return { scratch: authority, uploads: null };
    case "lineage":
      return { scratch: authority, uploads: null };
    case "chat":
      return { scratch: null, uploads: authority };
    case "owners":
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
  | { kind: "owners" }
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

/**
 * A near-miss owner spelling that only the server can fully answer (it knows which Works and chats
 * exist). `reason` already holds the answer the contracts can give alone.
 */
export type OwnerSlip =
  /** `@tea-notes`: a name where a handle belongs. */
  | { kind: "name"; scheme: OwnedContextUriScheme; token: string }
  /** `@p3`: a subagent's handle where its chat's belongs. */
  | { kind: "subagent"; scheme: OwnedContextUriScheme; token: string }
  /** `@W3`: handles are lowercase. */
  | { kind: "uppercase"; scheme: OwnedContextUriScheme; token: string }
  /** `@x` or `@/x` with no usable handle. */
  | { kind: "no-handle"; scheme: OwnedContextUriScheme };

type ContextUriParseError = {
  ok: false;
  /** `unknownScheme` marks a URI that names no context scheme, so it addresses no document. */
  error: { uri: string; reason: string; unknownScheme?: string; slip?: OwnerSlip };
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
  scheme: OwnedContextUriScheme,
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
  if (scheme === "uploads" && "workId" in authority) {
    throw new RangeError("Uploads belong to a chat, not a Work");
  }
  if ("workId" in authority && !authority.workHandle) {
    throw new RangeError("No Work has no address");
  }
  return formatParsedContextUri(scheme, normalizedPath, toParsedAuthority(authority));
}

function toParsedAuthority(authority: CanonicalContextAuthority): ParsedContextAuthority {
  if ("kind" in authority) return authority;
  const workHandle = decodeWorkHandle(authority.workHandle);
  if (!workHandle) throw new RangeError("Invalid Work handle");
  return { kind: "work", workHandle };
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
  while (segments[0]?.startsWith(OWNER_SIGIL)) qualifiers.push(segments.shift() ?? "");
  if (qualifiers.length === 0) {
    return { ok: true, value: { authority: { kind: "contextual" }, rawPath } };
  }
  if (qualifiers.length > 1) {
    return invalidContextUri(
      rawUri,
      `Authority qualifier chains are not yet supported for scheme "${scheme}"`,
    );
  }
  if (!isOwnedContextScheme(scheme)) {
    return invalidContextUri(
      rawUri,
      `Scheme "${scheme}" does not yet support authority qualifiers`,
    );
  }
  const token = (qualifiers[0] ?? "").slice(OWNER_SIGIL.length);
  if (token === "") return parseBareSigil(scheme, segments, rawUri);
  return parseOwnerToken(scheme, token, segments, rawUri);
}

/** `@` with no handle after it: a listing request, or the #875 spelling `@/c12/`, which is refused. */
function parseBareSigil(
  scheme: OwnedContextUriScheme,
  segments: string[],
  rawUri: string,
): AuthorityParseResult {
  const first = segments[0];
  if (first === undefined) {
    return { ok: true, value: { authority: { kind: "owners" }, rawPath: "" } };
  }
  const classified = classifyHandleToken(first);
  const authority =
    classified.kind === "handle" ? ownerAuthority(scheme, classified.handle.handle) : null;
  if (authority) {
    return invalidContextUri(
      rawUri,
      `Handles follow ${OWNER_SIGIL} directly: ${formatParsedContextUri(scheme, "", authority)}…`,
    );
  }
  return noHandleError(scheme, rawUri);
}

function parseOwnerToken(
  scheme: OwnedContextUriScheme,
  token: string,
  segments: string[],
  rawUri: string,
): AuthorityParseResult {
  const classified = classifyHandleToken(token);
  const rest = segments.join("/");
  switch (classified.kind) {
    case "handle": {
      const authority = ownerAuthority(scheme, classified.handle.handle);
      if (authority) return { ok: true, value: { authority, rawPath: rest } };
      const { kind } = classified.handle;
      if (kind === "subagent") {
        return invalidContextUri(rawUri, SUBAGENT_NOT_AN_OWNER, {
          kind: "subagent",
          scheme,
          token,
        });
      }
      return scheme === "uploads" && kind === "work"
        ? invalidContextUri(rawUri, uploadsBelongToChat)
        : noHandleError(scheme, rawUri);
    }
    case "uppercase": {
      const authority = ownerAuthority(scheme, classified.lower);
      return invalidContextUri(
        rawUri,
        authority
          ? `Handles are lowercase: ${formatParsedContextUri(scheme, "", authority)}…`
          : unknownOwnerHandle(scheme),
        { kind: "uppercase", scheme, token },
      );
    }
    case "leading-zero":
      return invalidContextUri(
        rawUri,
        `Invalid handle "${token}". Handles are a letter and digits with no leading zero.`,
      );
    case "name":
      return scheme === "scratch"
        ? invalidContextUri(rawUri, `Unknown Work ${token}. List Works with work list.`, {
            kind: "name",
            scheme,
            token,
          })
        : noHandleError(scheme, rawUri);
    case "unknown-letter":
      return noHandleError(scheme, rawUri);
  }
}

/** The authority a handle names under a scheme, or null when the scheme takes no such owner. */
function ownerAuthority(
  scheme: OwnedContextUriScheme,
  handle: string,
): ParsedContextAuthority | null {
  const parsed = parseHandle(handle);
  if (!parsed) return null;
  if (parsed.kind === "chat") {
    return scheme === "uploads"
      ? { kind: "chat", chatRef: handle }
      : { kind: "lineage", rootThreadRef: handle };
  }
  const workHandle = decodeWorkHandle(handle);
  return scheme === "scratch" && workHandle ? { kind: "work", workHandle } : null;
}

function noHandleError(scheme: OwnedContextUriScheme, rawUri: string): ContextUriParseError {
  return invalidContextUri(rawUri, unknownOwnerHandle(scheme), { kind: "no-handle", scheme });
}

function unknownOwnerHandle(scheme: OwnedContextUriScheme): string {
  return scheme === "scratch"
    ? "@ takes a handle: scratch://@w3/… for a Work, scratch://@c12/… for a chat's lineage. List them with ls scratch://@."
    : "@ takes a chat's handle: uploads://@c12/… . List chats with files with ls uploads://@.";
}

/** Schemes whose address takes an owner authority; the complement of the project-scoped ones. */
export function isOwnedContextScheme(scheme: ContextUriScheme): scheme is OwnedContextUriScheme {
  return (OWNED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
}

/** Whether a Work (not a chat) may own documents in this scheme: Scratch only. */
export function isWorkScopedScheme(scheme: ContextUriScheme): scheme is WorkScopedContextUriScheme {
  return scheme === "scratch";
}

/** Schemes whose documents belong to the project (or, for `user://`, the user), never to a Work. */
export function isProjectScopedScheme(
  scheme: ContextUriScheme,
): scheme is ProjectScopedContextUriScheme {
  return (PROJECT_SCOPED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
}

/** The sigil before an owner's handle. */
export const OWNER_SIGIL = "@";

/** The one serializer for addresses. Spells parsed syntax; it does not resolve or grant authority. */
export function formatParsedContextUri(
  scheme: ContextUriScheme,
  path: string,
  authority: ParsedContextAuthority,
): string {
  const qualifier = ownerQualifier(authority);
  if (qualifier === null) return path ? `${scheme}://${path}` : `${scheme}://`;
  if (authority.kind === "owners") return `${scheme}://${qualifier}`;
  return path ? `${scheme}://${qualifier}/${path}` : `${scheme}://${qualifier}/`;
}

/** One owner segment of an address, `@w3/`: the text a typed address completes with. */
export function ownerSegment(authority: ParsedContextAuthority): string | null {
  const qualifier = ownerQualifier(authority);
  return qualifier === null ? null : `${qualifier}/`;
}

function ownerQualifier(authority: ParsedContextAuthority): string | null {
  switch (authority.kind) {
    case "contextual":
      return null;
    case "owners":
      return OWNER_SIGIL;
    case "lineage":
      return OWNER_SIGIL + chatHandle(authority.rootThreadRef);
    case "chat":
      return OWNER_SIGIL + chatHandle(authority.chatRef);
    case "work": {
      const workHandle = decodeWorkHandle(authority.workHandle);
      if (!workHandle) throw new RangeError("Invalid Work handle");
      return OWNER_SIGIL + workHandle;
    }
  }
}

function chatHandle(ref: string): string {
  if (parseHandle(ref)?.kind !== "chat") throw new RangeError("Invalid chat handle");
  return ref;
}

function invalidContextUri(uri: string, reason: string, slip?: OwnerSlip): ContextUriParseError {
  return { ok: false, error: slip ? { uri, reason, slip } : { uri, reason } };
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

const uploadsBelongToChat =
  "Uploads belong to a chat, not a Work. Use uploads://x for this chat's files, or ls uploads://@ to list chats with files.";
const SUBAGENT_NOT_AN_OWNER = "Use the chat's handle, not a subagent's.";
