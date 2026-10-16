/**
 * context-uri — canonical frontend parsing, formatting, and route adaptation for context URIs.
 */
import {
  canonicalContextUri,
  isWorkScopedScheme,
  type ParsedContextUri,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export type ContextUri = Omit<ParsedContextUri, "path"> & {
  path: string;
};

/**
 * Parsed URI destination before the route owner supplies command ownership. A
 * chat's Scratch names its lineage in `rootThreadId` and has no Work.
 */
export type ParsedContextUriTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
  rootThreadId?: string;
};

export type ActiveWorkHandle = { id: string; handle: string | null };

/** The lineages a chat's URIs can name: its own, and any other by its first chat's handle. */
export type ChatLineages = {
  /** The chat's own lineage: what a bare `scratch://` means in a No Work chat. */
  own: string | null;
  /** The first chat's id for a handle such as `c12`, or null when the app does not know it. */
  idForRef(rootThreadRef: string): string | null;
};

/** The chats a chat's `uploads://` URIs can name: its own, and any other by its handle. */
export type ChatUploadOwners = {
  /** The chat's own id: what a bare `uploads://` means. A subagent's is its top chat's. */
  own: string | null;
  /** The chat's id for a handle such as `c15`, or null when the app does not know it. */
  idForRef(chatRef: string): string | null;
};

/**
 * The chat whose uploads an `uploads://` URI names, or null for any other URI. A Work route
 * can't name an upload, so a chat door opens it by its document in the chat's catalog.
 */
export function chatIdForUploadsUri(uri: string, chats: ChatUploadOwners): string | null {
  const parsed = parseContextUri(uri);
  if (!parsed || parsed.scheme !== "uploads") return null;
  if (parsed.authority.kind === "chat") return chats.idForRef(parsed.authority.chatRef);
  return parsed.authority.kind === "contextual" ? chats.own : null;
}

export function parseContextUri(uri: string): ContextUri | null {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return null;
  return { ...parsed.value, path: formatContextPath(parsed.value.path) };
}

/**
 * The context URI a tool path names: bare paths are manuscript paths. `null`
 * for a path under a scheme that addresses no writer document (`skills://`),
 * which must never be filed under the manuscript, and for a path that parses
 * to no address (`uploads://@/c1/notes`, `a/../b`). Never throws.
 */
export function contextUriFromWritePath(path: string): string | null {
  const parsed = parseUnifiedContextUri(path);
  if (parsed.ok) return parsed.value.normalized;
  if (parsed.error.unknownScheme !== undefined) return null;
  // A model-written path is untrusted: the serializer throws on reserved or
  // traversing segments, and a render path must show such a path as text.
  try {
    return canonicalContextUri("manuscript", path.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

export function contextRouteTargetFromUri(
  uri: string,
  activeWork: ActiveWorkHandle,
  availableWorks: readonly ActiveWorkHandle[],
  noWorkId: string,
  lineages?: ChatLineages,
): ParsedContextUriTarget | null {
  const parsed = parseContextUri(uri);
  if (!parsed) return null;

  // Uploads belong to a chat; no Work or lineage route holds one (see `chatIdForUploadsUri`).
  if (parsed.scheme === "uploads") return null;
  if (!isWorkScopedScheme(parsed.scheme)) {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }

  const inLineage = (rootThreadId: string | null | undefined): ParsedContextUriTarget | null =>
    rootThreadId ? { scheme: parsed.scheme, path: parsed.path, workId: null, rootThreadId } : null;
  if (parsed.authority.kind === "lineage")
    return inLineage(lineages?.idForRef(parsed.authority.rootThreadRef));
  // No Work has no Scratch of its own: its chats' notes belong to their lineage.
  if (parsed.scheme === "scratch") {
    if (parsed.authority.kind === "owners") return null;
    if (parsed.authority.kind === "contextual" && activeWork.id === noWorkId)
      return inLineage(lineages?.own);
  }
  if (parsed.authority.kind === "contextual") {
    return { scheme: parsed.scheme, path: parsed.path, workId: activeWork.id };
  }
  if (parsed.authority.kind === "chat" || parsed.authority.kind === "owners") return null;
  const requestedHandle = parsed.authority.workHandle;
  const qualified = availableWorks.find(({ handle }) => handle === requestedHandle);
  return qualified ? { scheme: parsed.scheme, path: parsed.path, workId: qualified.id } : null;
}

export function canOpenContextUri(
  uri: string,
  activeWork: ActiveWorkHandle,
  availableWorks: readonly ActiveWorkHandle[],
  noWorkId: string,
  lineages?: ChatLineages,
): boolean {
  return contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId, lineages) !== null;
}

function formatContextPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
