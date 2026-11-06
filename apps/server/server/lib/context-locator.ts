/**
 * One writer-chosen context end as a route resolves it: the address a move or a copy
 * names, and the container its files live in. Each route parses its own locators and words
 * its own refusals; these are the meanings they share, so a move and a copy cannot disagree
 * about who owns an address or which URI spells it.
 */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
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
import type { FileTarget } from "../domains/file-policy/index.js";
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
export function containerOf(locator: ResolvedContextLocator, projectId: string): FileTarget {
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
  return Ok({ scope: "project", scheme: scheme as ProjectContextFsScheme, path });
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
