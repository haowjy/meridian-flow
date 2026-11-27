import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { DocumentId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { ResolvedWorkAuthority } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import { projectBrowseContextUri } from "../domains/context/browse-layer-scheme.js";
import {
  type ContextError,
  type HeldContextNodeAddress,
  type ProjectContextAvailabilityPort,
  type ProjectContextFsScheme,
  parseUnifiedContextUri,
  type UnifiedContextPortFactory,
  type WorkScopedContextFsScheme,
} from "../domains/context/index.js";
import {
  type FileAccess,
  type FileTarget,
  isFileAccessDenied,
} from "../domains/file-policy/index.js";
import type { ProjectWorkAuthorityResolver } from "../domains/projects/index.js";
import { Err, Ok, type Result } from "../shared/result.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";

export type ProjectLocator = {
  scope: "project";
  scheme: ProjectContextFsScheme;
  path: string;
};

export type WorkLocator = {
  scope: "work";
  scheme: WorkScopedContextFsScheme;
  workId: string;
  path: string;
};

export type LineageLocator = {
  scope: "lineage";
  scheme: "scratch";
  rootThreadId: string;
  path: string;
};

export type ContextLocator = ProjectLocator | WorkLocator | LineageLocator;

export type ResolvedWorkLocator = Omit<WorkLocator, "workId"> & {
  authority: ResolvedWorkAuthority;
};
export type ResolvedLineageLocator = LineageLocator & {
  authority: { kind: "lineage"; rootThreadRef: string };
};
export type ResolvedContextLocator = ProjectLocator | ResolvedWorkLocator | ResolvedLineageLocator;

export function locatorUri(locator: ResolvedContextLocator, path = locator.path): string {
  return locator.scope !== "project"
    ? projectBrowseContextUri(locator.scheme, path, locator.authority)
    : projectBrowseContextUri(locator.scheme, path);
}

export function containerOf(
  locator: ResolvedContextLocator | ChatLocator,
  projectId: string,
): FileTarget {
  if (locator.scope === "chat")
    return {
      kind: "container",
      scheme: "uploads",
      owner: {
        scope: "chat",
        projectId: projectId as ProjectId,
        threadId: locator.chatId as ThreadId,
      },
    };
  return locator.scope === "project"
    ? {
        kind: "container",
        scheme: locator.scheme,
        owner: { scope: "project", projectId: projectId as ProjectId },
      }
    : locator.scope === "lineage"
      ? {
          kind: "container",
          scheme: "scratch",
          owner: {
            scope: "lineage",
            projectId,
            rootThreadId: locator.rootThreadId,
          },
        }
      : {
          kind: "container",
          scheme: locator.scheme,
          owner: { scope: "work", workId: locator.authority.workId as WorkId },
        };
}

export type ChatLocator = { scope: "chat"; scheme: "uploads"; chatId: string; path: string };

export type LocatorRefusal =
  | { reason: "invalid_uri"; error: ContextError }
  | { reason: "work_missing" }
  | { reason: "chat_missing" };

export type LocatorDeps = {
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
};

export async function resolveLocatorUri(
  deps: LocatorDeps,
  projectId: string,
  uri: string,
): Promise<Result<ResolvedContextLocator | ChatLocator, LocatorRefusal>> {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return Err({ reason: "invalid_uri", error: parsed.error });
  const { scheme, path, authority } = parsed.value;
  if (authority.kind === "work") {
    const resolved = await deps.workAuthorityResolver.byHandle(projectId, authority.workHandle);
    if (!resolved) return Err({ reason: "work_missing" });
    return Ok({
      scope: "work",
      scheme: scheme as WorkScopedContextFsScheme,
      path,
      authority: resolved,
    });
  }
  if (authority.kind === "lineage") {
    const lineage = await deps.contextPorts.lineages.byRef(projectId, authority.rootThreadRef);
    if (!lineage) return Err({ reason: "chat_missing" });
    return Ok({
      scope: "lineage",
      scheme: "scratch",
      path,
      rootThreadId: lineage.rootThreadId,
      authority: { kind: "lineage", rootThreadRef: authority.rootThreadRef },
    });
  }
  if (authority.kind === "chat") {
    const chat = await deps.contextPorts.chats.byRef(projectId, authority.chatRef);
    if (!chat) return Err({ reason: "chat_missing" });
    return Ok({ scope: "chat", scheme: "uploads", chatId: chat.chatId, path });
  }
  if (!isProjectScopedScheme(scheme)) return Err({ reason: "work_missing" });
  return Ok({ scope: "project", scheme: scheme as ProjectContextFsScheme, path });
}

export async function resolveLocator(
  deps: LocatorDeps,
  projectId: string,
  locator: ContextLocator,
): Promise<Result<ResolvedContextLocator, LocatorRefusal>> {
  if (locator.scope === "project") return Ok(locator);
  if (locator.scope === "lineage") {
    const lineage = await deps.contextPorts.lineages.byId(projectId, locator.rootThreadId);
    if (!lineage) return Err({ reason: "chat_missing" });
    return Ok({ ...locator, authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef } });
  }
  const authority = await deps.workAuthorityResolver.byId(projectId, locator.workId);
  if (!authority) return Err({ reason: "work_missing" });
  return Ok({ scope: "work", scheme: locator.scheme, path: locator.path, authority });
}

export async function containerOfUri(
  deps: LocatorDeps,
  projectId: string,
  uri: string,
): Promise<FileTarget | null> {
  const resolved = await resolveLocatorUri(deps, projectId, uri);
  return resolved.ok ? containerOf(resolved.value, projectId) : null;
}

export function canCommandContextUri(
  deps: LocatorDeps & { fileAccess: Pick<FileAccess, "authorize"> },
  input: { projectId: string; userId: string },
): (uri: string) => Promise<boolean> {
  return async (uri) => {
    const target = await containerOfUri(deps, input.projectId, uri);
    if (!target) return false;
    const grant = await deps.fileAccess.authorize(
      { accountId: input.userId as UserId },
      target,
      "command",
    );
    return !isFileAccessDenied(grant);
  };
}

export function throwLocatorRefusal(refusal: LocatorRefusal): never {
  if (refusal.reason === "invalid_uri") contextErrorToHttp(refusal.error);
  if (refusal.reason === "work_missing") throwContextWorkUnavailableHttpError("work_missing");
  throw createError({ statusCode: 404, message: "Chat not found" });
}

// Authorize on the returned `address.id`, never on the id asked for: a join's forward makes the asked id name another row
export async function locateNode(
  deps: LocatorDeps & { availability: ProjectContextAvailabilityPort },
  input: {
    projectId: string;
    userId: string;
    node: { kind: "document"; id: DocumentId } | { kind: "folder"; id: string };
  },
): Promise<
  Result<
    { address: HeldContextNodeAddress; locator: ResolvedContextLocator | ChatLocator },
    LocatorRefusal | { reason: "not_found" }
  >
> {
  const held = await deps.availability.held(
    { projectId: input.projectId as ProjectId, node: input.node },
    { userId: input.userId },
  );
  if (!held || held.kind === "unreachable") return Err({ reason: "not_found" });
  const locator = await resolveLocatorUri(deps, input.projectId, held.address.uri);
  return locator.ok ? Ok({ address: held.address, locator: locator.value }) : locator;
}
