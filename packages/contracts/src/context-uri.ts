import { validateContextEntryName } from "./context-entry-validation.js";
import { classifyHandleToken, decodeWorkHandle, parseHandle, type WorkHandle } from "./handles.js";
import { canonicalLeaf } from "./protocol/document-filename.js";
import { readSegment } from "./protocol/entry-segment.js";
import type { ResolvedWorkAuthority } from "./works/index.js";

export const CONTEXT_URI_SCHEMES = [
  "manuscript",
  "kb",
  "user",
  "unfiled",
  "scratch",
  "uploads",
  "agents",
] as const;
export type ContextUriScheme = (typeof CONTEXT_URI_SCHEMES)[number];

export const CONTEXT_URI_SCHEME_NAMES = {
  manuscript: "Manuscript",
  kb: "Knowledge",
  user: "Your files",
  unfiled: "Unfiled",
  scratch: "Scratch",
  uploads: "Uploads",
  agents: ".agents",
} as const satisfies Record<(typeof CONTEXT_URI_SCHEMES)[number], string>;

export function isDraftedScheme(scheme: ContextUriScheme): boolean {
  return (
    scheme === "manuscript" ||
    scheme === "kb" ||
    scheme === "user" ||
    scheme === "unfiled" ||
    scheme === "agents"
  );
}

export const PROJECT_SCOPED_CONTEXT_URI_SCHEMES = [
  "manuscript",
  "kb",
  "user",
  "unfiled",
  "agents",
] as const;
export type ProjectScopedContextUriScheme = (typeof PROJECT_SCOPED_CONTEXT_URI_SCHEMES)[number];

export const OWNED_CONTEXT_URI_SCHEMES = ["scratch", "uploads"] as const;
export type OwnedContextUriScheme = (typeof OWNED_CONTEXT_URI_SCHEMES)[number];

export type WorkScopedContextUriScheme = "scratch";

export type CanonicalContextUri = string;

export interface ContextSchemeCapabilities {
  readonly writable: boolean;
  readonly searchable: boolean;
  readonly creatable: boolean;
}

export type ParsedContextAuthority =
  | { kind: "contextual" }
  | { kind: "owners" }
  | { kind: "lineage"; rootThreadRef: string }
  | { kind: "chat"; chatRef: string }
  | { kind: "work"; workHandle: WorkHandle };

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

export type CanonicalContextAuthority =
  | { kind: "contextual" }
  | { kind: "owners" }
  | { kind: "lineage"; rootThreadRef: string }
  | { kind: "chat"; chatRef: string }
  | ResolvedWorkAuthority;

export interface ParsedContextUri {
  scheme: ContextUriScheme;
  authority: ParsedContextAuthority;
  path: string;
  normalized: string;
}

export type OwnerSlip =
  | { kind: "name"; scheme: OwnedContextUriScheme; token: string }
  | { kind: "subagent"; scheme: OwnedContextUriScheme; token: string }
  | { kind: "uppercase"; scheme: OwnedContextUriScheme; token: string }
  | { kind: "no-handle"; scheme: OwnedContextUriScheme };

type ContextUriParseError = {
  ok: false;
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

const HOME_ALIAS = /^~(?:\/(.*))?$/;
const PROJECT_AGENTS_ALIAS = /^\.agents(?:\/(.*))?$/;

function aliasedScheme(
  bare: string,
  schemes: readonly ContextUriScheme[],
): { scheme: ContextUriScheme; rawPath: string } | null {
  const home = HOME_ALIAS.exec(bare);
  if (home && isContextScheme("user", schemes)) return { scheme: "user", rawPath: home[1] ?? "" };
  const agents = PROJECT_AGENTS_ALIAS.exec(bare);
  if (agents && isContextScheme("agents", schemes)) {
    return { scheme: "agents", rawPath: agents[1] ?? "" };
  }
  return null;
}

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
  const prefix = schemePrefix(trimmed);
  if (prefix) {
    const parsedScheme = prefix.name;
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
    rawPath = trimmed.slice(prefix.length);
  } else {
    const alias = aliasedScheme(trimmed, schemes);
    scheme = alias?.scheme ?? bareDefault;
    rawPath = alias ? alias.rawPath : trimmed;
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
  const draftSegmentIndex = segments.findIndex((segment) => segment.startsWith(DRAFT_SIGIL));
  if (draftSegmentIndex !== -1) {
    return invalidContextUri(
      raw,
      draftNameRefusal(scheme, authorityResult.value.authority, segments, draftSegmentIndex),
    );
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

const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):(\/+)/i;

function schemePrefix(raw: string): { name: string; length: number } | null {
  const match = SCHEME_PREFIX.exec(raw);
  const name = (match?.[1] ?? "").toLowerCase();
  if (!match || (match[2] && match[2].length < 2 && !isContextUriScheme(name))) return null;
  return { name, length: match[0].length };
}

export function addressScheme(raw: string): ContextUriScheme | null {
  const parsed = parseUnifiedContextUri(raw);
  return parsed.ok ? parsed.value.scheme : null;
}

export function isCanonicalAddress(raw: string): boolean {
  const parsed = parseUnifiedContextUri(raw);
  return parsed.ok && parsed.value.normalized === raw;
}

export function writtenForm(raw: string): "address" | "foreign" | "path" {
  const trimmed = raw.trim();
  const prefix = schemePrefix(trimmed);
  if (prefix) return isContextUriScheme(prefix.name) ? "address" : "foreign";
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? "foreign" : "path";
}

export function joinContextUri(base: string, rest: string): string {
  const parsed = parseUnifiedContextUri(base);
  if (!parsed.ok) throw new RangeError(`Not a context address: ${base}`);
  const { scheme, authority, path } = parsed.value;
  return formatParsedContextUri(scheme, [path, rest].filter(Boolean).join("/"), authority);
}

export function contextRootUri(scheme: ContextUriScheme): string {
  return formatParsedContextUri(scheme, "", { kind: "contextual" });
}

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
  if (token === "") {
    // keep: Retired @/ empty-owner spelling must stay distinct from the bare @ listing token
    if (segments.length === 0 && rawPath.replace(/^\/+/, "").startsWith("@/")) {
      return invalidContextUri(rawUri, retiredEmptyOwner(scheme));
    }
    return parseBareSigil(scheme, segments, rawUri);
  }
  return parseOwnerToken(scheme, token, segments, rawUri);
}

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
      return invalidContextUri(rawUri, `Invalid handle "${token}": no leading zeros.`);
    case "name":
      return scheme === "scratch"
        ? invalidContextUri(rawUri, `Unknown Work ${token}.`, {
            kind: "name",
            scheme,
            token,
          })
        : noHandleError(scheme, rawUri);
    case "unknown-letter":
      return noHandleError(scheme, rawUri);
  }
}

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

function retiredEmptyOwner(scheme: OwnedContextUriScheme): string {
  return `"@/" is not an address; owners are listed by ls ${scheme}://@.`;
}

function unknownOwnerHandle(scheme: OwnedContextUriScheme): string {
  return scheme === "scratch"
    ? "Owners are listed by ls scratch://@."
    : "Chats with files are listed by ls uploads://@.";
}

export function isOwnedContextScheme(scheme: ContextUriScheme): scheme is OwnedContextUriScheme {
  return (OWNED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
}

export function isWorkScopedScheme(scheme: ContextUriScheme): scheme is WorkScopedContextUriScheme {
  return scheme === "scratch";
}

export function isProjectScopedScheme(
  scheme: ContextUriScheme,
): scheme is ProjectScopedContextUriScheme {
  return (PROJECT_SCOPED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
}

export const OWNER_SIGIL = "@";
export const DRAFT_SIGIL = "~";
const DRAFT_NAME_RULE = 'Names cannot start with "~".';

function draftNameRefusal(
  scheme: ContextUriScheme,
  authority: ParsedContextAuthority,
  segments: string[],
  draftSegmentIndex: number,
): string {
  const segment = segments[draftSegmentIndex] ?? "";
  if (draftSegmentIndex < segments.length - 1) {
    const repairedPath = [
      ...segments.slice(0, draftSegmentIndex),
      ...segments.slice(draftSegmentIndex + 1),
    ].join("/");
    const repairedUri = formatParsedContextUri(scheme, repairedPath, authority);
    return `${DRAFT_NAME_RULE} Without that segment: ${repairedUri}.`;
  }

  const repairedName = validateContextEntryName(segment.slice(DRAFT_SIGIL.length));
  if (!repairedName.ok) return DRAFT_NAME_RULE;
  const repairedPath = [...segments.slice(0, draftSegmentIndex), repairedName.value].join("/");
  const repairedUri = formatParsedContextUri(scheme, repairedPath, { kind: "contextual" });
  return `${DRAFT_NAME_RULE} Without it: ${repairedUri}.`;
}

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

export function displayContextUri(text: string): string {
  return text
    .replace(/(?<![\w/])agents:\/\//g, ".agents/")
    .replace(/(?<![\w/])user:\/\/\.agents(?![\w.-])/g, "~/.agents");
}

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

export function splitDocumentHrefSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index < 0
    ? { path: value, suffix: "" }
    : { path: value.slice(0, index), suffix: value.slice(index) };
}

export function documentTitleFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const parsed = parseUnifiedContextUri(uri);
  const segment = (parsed.ok ? parsed.value.path : uri).split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  return canonicalLeaf(readSegment(segment).name);
}

const uploadsBelongToChat =
  "Uploads belong to chats. This chat's are at uploads://x; other chats' are listed by ls uploads://@.";
const SUBAGENT_NOT_AN_OWNER = "An owner is a chat's handle, not a subagent's.";
