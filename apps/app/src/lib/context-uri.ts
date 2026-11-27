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

export type ParsedContextUriTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
  rootThreadId?: string;
};

export type ActiveWorkHandle = { id: string; handle: string | null };

export type ChatLineages = {
  own: string | null;
  idForRef(rootThreadRef: string): string | null;
};

export type ChatUploadOwners = {
  own: string | null;
  idForRef(chatRef: string): string | null;
};

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

export function contextUriFromWritePath(path: string): string | null {
  const parsed = parseUnifiedContextUri(path);
  if (parsed.ok) return parsed.value.normalized;
  if (parsed.error.unknownScheme !== undefined) return null;
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

  if (parsed.scheme === "uploads") return null;
  if (!isWorkScopedScheme(parsed.scheme)) {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }

  const inLineage = (rootThreadId: string | null | undefined): ParsedContextUriTarget | null =>
    rootThreadId ? { scheme: parsed.scheme, path: parsed.path, workId: null, rootThreadId } : null;
  if (parsed.authority.kind === "lineage")
    return inLineage(lineages?.idForRef(parsed.authority.rootThreadRef));
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
