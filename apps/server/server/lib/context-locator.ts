/**
 * One writer-chosen context end as a route resolves it: the address a move, copy or create
 * names, the owner it resolves to, and the container its files live in. Each route parses its
 * own locators and words its own refusals; these are the meanings they share, so they cannot
 * disagree about who owns an address, whether the writer can edit it, or which URI spells it.
 */
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

export type NoWorkLocator = {
  scope: "none";
  scheme: WorkScopedContextFsScheme;
  path: string;
};

export type LineageLocator = {
  scope: "lineage";
  scheme: "scratch";
  rootThreadId: string;
  path: string;
};

export type ContextLocator = ProjectLocator | NoWorkLocator | WorkLocator | LineageLocator;

export type ResolvedWorkLocator = Omit<WorkLocator, "workId"> & {
  authority: ResolvedWorkAuthority;
};
export type ResolvedLineageLocator = LineageLocator & {
  authority: { kind: "lineage"; rootThreadRef: string };
};
export type ResolvedContextLocator = ProjectLocator | ResolvedWorkLocator | ResolvedLineageLocator;

/** The URI that spells a locator's address. */
export function locatorUri(locator: ResolvedContextLocator, path = locator.path): string {
  return locator.scope !== "project"
    ? projectBrowseContextUri(locator.scheme, path, locator.authority)
    : projectBrowseContextUri(locator.scheme, path);
}

/** The container a locator's files live in: the file-policy target an edit is granted on. */
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

/** Why a URI named no owner this project can reach. */
export type LocatorRefusal =
  | { reason: "invalid_uri"; error: ContextError }
  | { reason: "work_missing" }
  | { reason: "chat_missing" };

export type LocatorDeps = {
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
};

/**
 * The owner a canonical URI names, resolved against this project: its Work, lineage or chat.
 * Uploads answer as a `chat` locator, which a move or copy refuses and a read serves.
 */
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
  // A Work-scoped or uploads address that names no owner belongs to no one this project can reach.
  if (!isProjectScopedScheme(scheme)) return Err({ reason: "work_missing" });
  return Ok({ scope: "project", scheme: scheme as ProjectContextFsScheme, path });
}

/**
 * The owner an unresolved locator names, resolved against this project: its Work (No Work for
 * `none`) or lineage. A Work or chat that is gone refuses.
 */
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
  const authority =
    locator.scope === "none"
      ? await deps.workAuthorityResolver.noWork(projectId)
      : await deps.workAuthorityResolver.byId(projectId, locator.workId);
  if (!authority) return Err({ reason: "work_missing" });
  return Ok({ scope: "work", scheme: locator.scheme, path: locator.path, authority });
}

/** The container a canonical address lives in, or null when it names no owner this project can reach. */
export async function containerOfUri(
  deps: LocatorDeps,
  projectId: string,
  uri: string,
): Promise<FileTarget | null> {
  const resolved = await resolveLocatorUri(deps, projectId, uri);
  return resolved.ok ? containerOf(resolved.value, projectId) : null;
}

/**
 * Whether the writer can still edit the address `uri` names: the recheck a move, a copy or a
 * create runs on a destination it resolved again inside its locks.
 */
export function canEditContextUri(
  deps: LocatorDeps & { fileAccess: Pick<FileAccess, "authorize" | "confirmEdit"> },
  input: { projectId: string; userId: string },
): (uri: string) => Promise<boolean> {
  return async (uri) => {
    const target = await containerOfUri(deps, input.projectId, uri);
    if (!target) return false;
    const grant = await deps.fileAccess.authorize(
      { accountId: input.userId as UserId },
      target,
      "edit",
    );
    return !isFileAccessDenied(grant) && (await deps.fileAccess.confirmEdit([grant])).length === 0;
  };
}

/** The HTTP answer a route gives a refused locator. */
export function throwLocatorRefusal(refusal: LocatorRefusal): never {
  if (refusal.reason === "invalid_uri") contextErrorToHttp(refusal.error);
  if (refusal.reason === "work_missing") throwContextWorkUnavailableHttpError("work_missing");
  throw createError({ statusCode: 404, message: "Chat not found" });
}

/**
 * Where this project holds a node, found by its id: the address the row stands at (following a
 * join's forward) and the owner that address names. `held` answers null for another project's
 * row and `unreachable` for a deleted, hidden or inconsistent one, so this one call is the
 * project check, the visibility check and the locator for a by-id route. Authorize on
 * `address.id`, never on the id asked for: a forwarded id names another row.
 */
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
