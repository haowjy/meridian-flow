/** Plain-data orchestration for committing a writer-visible context identity. */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { MoveContextEntryRequest, MoveContextEntryResult } from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { ResolvedWorkAuthority } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import { projectBrowseContextUri } from "../domains/context/browse-layer-scheme.js";
import {
  type ContextPort,
  contextPortForProjectAuthorities,
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
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "./context-mutation-validation.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export interface ContextMoveRouteDeps {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  projectRepo: ProjectRepository;
  workRepo: WorkRepository;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

type ProjectLocator = {
  scope: "project";
  scheme: ProjectContextFsScheme;
  path: string;
};

type WorkLocator = {
  scope: "work";
  scheme: WorkScopedContextFsScheme;
  workId: string;
  path: string;
};

type NoWorkLocator = {
  scope: "none";
  scheme: WorkScopedContextFsScheme;
  path: string;
};

type LineageLocator = { scope: "lineage"; scheme: "scratch"; rootThreadId: string; path: string };
export type ContextMoveLocator = ProjectLocator | NoWorkLocator | WorkLocator | LineageLocator;

export interface ParsedContextMove {
  operationId: string;
  expected: MoveContextEntryRequest["expected"];
  destinationParent?: MoveContextEntryRequest["destinationParent"];
  position?: MoveContextEntryRequest["position"];
  source: ContextMoveLocator;
  destination: ContextMoveLocator;
  name?: string;
}

type ResolvedWorkLocator = Omit<WorkLocator, "workId"> & { authority: ResolvedWorkAuthority };
type ResolvedLineageLocator = LineageLocator & {
  authority: { kind: "lineage"; rootThreadRef: string };
};
export type ResolvedContextMoveLocator =
  | ProjectLocator
  | ResolvedWorkLocator
  | ResolvedLineageLocator;
export type ResolvedContextMove = {
  operationId: string;
  expected: MoveContextEntryRequest["expected"];
  destinationParent?: MoveContextEntryRequest["destinationParent"];
  position?: MoveContextEntryRequest["position"];
  source: ResolvedContextMoveLocator;
  destination: ResolvedContextMoveLocator;
  name?: string;
};

function uploadsNotMovable() {
  return createError({
    statusCode: 400,
    message: "Uploads belong to the chat that received them and can't be moved",
  });
}

function parseWorkId(raw: unknown, field: "sourceWorkId" | "destinationWorkId") {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw createError({ statusCode: 400, message: `\`${field}\` must be a non-empty string` });
  }
  return raw.trim();
}

function parseLocator(input: {
  scheme: unknown;
  path: string;
  workId: string | null;
  workIdField: "sourceWorkId" | "destinationWorkId";
  rootThreadId?: unknown;
}): ContextMoveLocator {
  if (!isProjectContextTreeScheme(input.scheme)) {
    throw createError({ statusCode: 400, message: "Context scheme is invalid" });
  }
  if (input.scheme === "uploads") throw uploadsNotMovable();
  if (input.rootThreadId != null) {
    if (input.scheme !== "scratch" || input.workId)
      throw createError({ statusCode: 400, message: "Choose one Scratch owner" });
    return {
      scope: "lineage",
      scheme: "scratch",
      path: input.path,
      rootThreadId: requireRequestId(input.rootThreadId, "rootThreadId"),
    };
  }
  if (isWorkScopedScheme(input.scheme)) {
    if (!input.workId) {
      return { scope: "none", scheme: input.scheme, path: input.path };
    }
    return {
      scope: "work",
      scheme: input.scheme as WorkScopedContextFsScheme,
      workId: input.workId,
      path: input.path,
    };
  }
  if (input.workId !== null) {
    throw createError({
      statusCode: 400,
      message: `\`${input.workIdField}\` is not valid for ${input.scheme}`,
    });
  }
  return { scope: "project", scheme: input.scheme as ProjectContextFsScheme, path: input.path };
}

/**
 * A writer-selected parent folder, by identity: a folder id, or a scheme root and its
 * owner, each with the missing-folder suffix (`createFolders`). Moves and creates share it.
 */
export function parseDestinationParent(
  raw: unknown,
): NonNullable<MoveContextEntryRequest["destinationParent"]> {
  const parent = raw as Record<string, unknown> | null;
  let destinationParent: NonNullable<MoveContextEntryRequest["destinationParent"]>;
  if (parent?.kind === "folder") {
    destinationParent = {
      kind: "folder",
      folderId: requireRequestId(parent.folderId, "destinationParent.folderId"),
    };
  } else if (
    parent?.kind === "root" &&
    isProjectContextTreeScheme(parent.scheme) &&
    parent.owner &&
    typeof parent.owner === "object"
  ) {
    const owner = parent.owner as Record<string, unknown>;
    destinationParent = {
      kind: "root",
      scheme: parent.scheme,
      owner: {
        workId: parseWorkId(owner.workId, "destinationWorkId"),
        ...(typeof owner.workHandle === "string" || owner.workHandle === null
          ? { workHandle: owner.workHandle }
          : {}),
        ...(owner.rootThreadId != null
          ? {
              rootThreadId: requireRequestId(
                owner.rootThreadId,
                "destinationParent.owner.rootThreadId",
              ),
              rootThreadRef: typeof owner.rootThreadRef === "string" ? owner.rootThreadRef : null,
            }
          : {}),
      },
    };
  } else throw createError({ statusCode: 400, message: "Destination parent is invalid" });
  if (parent.createFolders !== undefined) {
    if (!Array.isArray(parent.createFolders))
      throw createError({
        statusCode: 400,
        message: "Destination folder suffix must be an array",
      });
    destinationParent.createFolders = parent.createFolders.map((segment) =>
      parseContextMutationName(segment, "destinationParent.createFolders"),
    );
  }
  return destinationParent;
}

export function parseContextMove(input: {
  sourceScheme: unknown;
  body: unknown;
}): ParsedContextMove {
  if (!input.body || typeof input.body !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = input.body as Record<string, unknown>;
  let position: MoveContextEntryRequest["position"];
  if (body.position !== undefined) {
    if (!body.position || typeof body.position !== "object")
      throw createError({ statusCode: 400, message: "Position is invalid" });
    const raw = body.position as Record<string, unknown>;
    if (raw.kind === "start" || raw.kind === "end") position = { kind: raw.kind };
    else if (raw.kind === "before" || raw.kind === "after")
      position = {
        kind: raw.kind,
        siblingId: requireRequestId(raw.siblingId, "position.siblingId"),
      };
    else throw createError({ statusCode: 400, message: "Position is invalid" });
  }
  const expected = body.expected as Record<string, unknown> | undefined;
  if (
    !expected ||
    (expected.kind !== "file" && expected.kind !== "folder") ||
    typeof expected.nodeId !== "string" ||
    !expected.nodeId.trim()
  ) {
    throw createError({ statusCode: 400, message: "Expected source identity is required" });
  }
  let destinationParent: MoveContextEntryRequest["destinationParent"];
  if (body.destinationParent !== undefined) {
    destinationParent = parseDestinationParent(body.destinationParent);
    if (destinationParent.kind === "root") {
      if (destinationParent.scheme !== body.destinationScheme)
        throw createError({ statusCode: 400, message: "Destination parent is invalid" });
      const owner = destinationParent.owner;
      if (
        (owner.workId ?? null) !== parseWorkId(body.destinationWorkId, "destinationWorkId") ||
        (owner.rootThreadId ?? null) !== (body.destinationRootThreadId ?? null)
      )
        throw createError({ statusCode: 400, message: "Destination root owner does not match" });
    }
  }
  const sourcePath = parseContextMutationPath(body.path, "path");
  const destinationFolderPath = parseContextMutationPath(
    body.destinationFolderPath,
    "destinationFolderPath",
    { allowRoot: true },
  );
  let name: string | undefined;
  if (body.newName !== undefined) {
    name = parseContextMutationName(body.newName, "newName");
  }
  return {
    operationId: requireRequestId(body.operationId, "operationId"),
    expected: { kind: expected.kind, nodeId: expected.nodeId },
    ...(destinationParent ? { destinationParent } : {}),
    ...(position ? { position } : {}),
    source: parseLocator({
      scheme: input.sourceScheme,
      path: sourcePath,
      workId: parseWorkId(body.sourceWorkId, "sourceWorkId"),
      workIdField: "sourceWorkId",
      rootThreadId: body.sourceRootThreadId,
    }),
    destination: parseLocator({
      scheme: body.destinationScheme,
      path: destinationFolderPath,
      workId: parseWorkId(body.destinationWorkId, "destinationWorkId"),
      workIdField: "destinationWorkId",
      rootThreadId: body.destinationRootThreadId,
    }),
    ...(name ? { name } : {}),
  };
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function locatorUri(locator: ResolvedContextMoveLocator, path = locator.path): string {
  return locator.scope !== "project"
    ? projectBrowseContextUri(locator.scheme, path, locator.authority)
    : projectBrowseContextUri(locator.scheme, path);
}

export async function commitContextMove(input: {
  port: ContextPort;
  userId: string;
  move: ResolvedContextMove;
  resolveDestinationLocator?: (uri: string) => Promise<ResolvedContextMoveLocator>;
  authorizeDestination?: (uri: string) => Promise<boolean>;
}): Promise<MoveContextEntryResult> {
  const name = input.move.name ?? basename(input.move.source.path);
  const destinationPath = joinPath(input.move.destination.path, name);
  const result = await input.port.commitWriterLocation(
    locatorUri(input.move.source, input.move.source.path),
    locatorUri(input.move.destination, destinationPath),
    {
      origin: { type: "human", userId: input.userId },
      expected: input.move.expected,
      destinationParent: input.move.destinationParent,
      position: input.move.position,
      authorizeDestination: input.authorizeDestination,
      operationId: input.move.operationId,
    },
  );
  if (!result.ok) {
    if (result.error.code === "stale_source" || result.error.code === "stale_target") {
      return {
        status: "retry",
        reason: result.error.code === "stale_source" ? "stale-source" : "stale-target",
      };
    }
    if (result.error.code === "conflict") {
      const collision = parseUnifiedContextUri(result.error.uri);
      if (!collision.ok) contextErrorToHttp(collision.error);
      const identityDestination = input.move.destinationParent?.kind === "folder";
      const destination =
        identityDestination && input.resolveDestinationLocator
          ? await input.resolveDestinationLocator(result.error.uri)
          : input.move.destination;
      const authorityMatches =
        destination.scope === "project"
          ? collision.value.authority.kind === "contextual"
          : destination.scope === "lineage"
            ? collision.value.authority.kind === "lineage" &&
              collision.value.authority.rootThreadRef === destination.authority.rootThreadRef
            : collision.value.authority.kind === "work" &&
              collision.value.authority.workHandle === destination.authority.workHandle;
      if (
        collision.value.scheme !== destination.scheme ||
        (!identityDestination && collision.value.path !== destinationPath) ||
        !authorityMatches
      ) {
        throw createError({
          statusCode: 500,
          message: "Context move conflict identity breached the resolved destination",
        });
      }
      return {
        status: "conflict",
        collision:
          destination.scope === "lineage"
            ? {
                scheme: destination.scheme,
                path: collision.value.path,
                authority: {
                  kind: "lineage",
                  rootThreadId: destination.rootThreadId,
                  rootThreadRef: destination.authority.rootThreadRef,
                },
              }
            : destination.scope === "work"
              ? {
                  scheme: destination.scheme,
                  path: collision.value.path,
                  authority: {
                    workId: destination.authority.workId,
                    workHandle: destination.authority.workHandle,
                  },
                }
              : {
                  scheme: destination.scheme,
                  path: collision.value.path,
                  authority: { kind: "project" },
                },
      };
    }
    contextErrorToHttp(result.error);
  }
  const committedDestination = result.value.destinationUri
    ? parseUnifiedContextUri(result.value.destinationUri)
    : null;
  return {
    status: "moved",
    ...(result.value.linkUpdate ? { linkUpdate: result.value.linkUpdate } : {}),
    scheme: committedDestination?.ok
      ? (committedDestination.value.scheme as MoveContextEntryRequest["destinationScheme"])
      : input.move.destination.scheme,
    path: result.value.destinationPath,
    name: basename(result.value.destinationPath),
  };
}

export async function handleContextMoveRequest(
  deps: ContextMoveRouteDeps,
  input: { projectId: string; userId: string; sourceScheme: unknown; body: unknown },
): Promise<MoveContextEntryResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const move = parseContextMove({ sourceScheme: input.sourceScheme, body: input.body });
  async function resolveLocator(
    locator: ContextMoveLocator,
    destination = false,
  ): Promise<ResolvedContextMoveLocator> {
    const destinationMissing = () =>
      contextErrorToHttp({
        code: "destination_missing",
        uri: `${locator.scheme}://${locator.path}`,
      });
    if (locator.scope === "project") return locator;
    if (locator.scope === "lineage") {
      const lineage = await deps.contextPorts.lineages.byId(input.projectId, locator.rootThreadId);
      if (!lineage) {
        if (destination && move.destinationParent) destinationMissing();
        throw createError({ statusCode: 404, message: "Chat not found" });
      }
      return { ...locator, authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef } };
    }
    const authority =
      locator.scope === "none"
        ? await deps.workAuthorityResolver.noWork(input.projectId)
        : await deps.workAuthorityResolver.byId(input.projectId, locator.workId);
    if (!authority) {
      // The immutable destination authority may have retired since preparation.
      // It is move repair, not a missing source or permission to recreate its path.
      if (destination && move.destinationParent) destinationMissing();
      throwContextWorkUnavailableHttpError("work_missing");
    }
    return { scope: "work", scheme: locator.scheme, path: locator.path, authority };
  }
  const resolvedMove: ResolvedContextMove = {
    operationId: move.operationId,
    expected: move.expected,
    destinationParent: move.destinationParent,
    position: move.position,
    source: await resolveLocator(move.source),
    destination: await resolveLocator(move.destination, true),
    ...(move.name ? { name: move.name } : {}),
  };
  const workIds = new Set(
    [resolvedMove.source, resolvedMove.destination].flatMap((locator) =>
      locator.scope === "work" ? [locator.authority.workId] : [],
    ),
  );
  const primaryWorkId =
    resolvedMove.source.scope === "work" ? resolvedMove.source.authority.workId : [...workIds][0];
  const works = await deps.workRepo.listByProject(input.projectId, { lifecycle: "all" });
  const port = await contextPortForProjectAuthorities({
    deps: {
      contextPorts: deps.contextPorts,
      works: deps.workRepo,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId,
    projectWorks: works,
  });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");
  // Move and rename need edit on what moves and on the folder it lands in (file-access §2).
  const containerOf = (locator: ResolvedContextMoveLocator): FileTarget =>
    locator.scope === "project"
      ? {
          kind: "container",
          scheme: locator.scheme,
          owner: { scope: "project", projectId: input.projectId as ProjectId },
        }
      : locator.scope === "lineage"
        ? {
            kind: "container",
            scheme: "scratch",
            owner: {
              scope: "lineage",
              projectId: input.projectId,
              rootThreadId: locator.rootThreadId,
            },
          }
        : {
            kind: "container",
            scheme: locator.scheme,
            owner: { scope: "work", workId: locator.authority.workId as WorkId },
          };
  async function resolveDestinationLocator(uri: string): Promise<ResolvedContextMoveLocator> {
    const parsed = parseUnifiedContextUri(uri);
    if (!parsed.ok) contextErrorToHttp(parsed.error);
    const { scheme, path, authority } = parsed.value;
    if (scheme === "uploads") throw uploadsNotMovable();
    if (authority.kind === "work") {
      const resolved = await deps.workAuthorityResolver.byHandle(
        input.projectId,
        authority.workHandle,
      );
      if (!resolved) throwContextWorkUnavailableHttpError("work_missing");
      return {
        scope: "work",
        scheme: scheme as WorkScopedContextFsScheme,
        path,
        authority: resolved,
      };
    }
    if (authority.kind === "lineage") {
      const lineage = await deps.contextPorts.lineages.byRef(
        input.projectId,
        authority.rootThreadRef,
      );
      if (!lineage) throw createError({ statusCode: 404, message: "Chat not found" });
      return {
        scope: "lineage",
        scheme: "scratch",
        path,
        rootThreadId: lineage.rootThreadId,
        authority: { kind: "lineage", rootThreadRef: authority.rootThreadRef },
      };
    }
    return { scope: "project", scheme: scheme as ProjectContextFsScheme, path };
  }
  const moved =
    resolvedMove.expected.kind === "file"
      ? documentTarget(resolvedMove.expected.nodeId)
      : containerOf(resolvedMove.source);
  const grants = [
    await requireFileGrant(deps.fileAccess, input.userId, moved, "edit"),
    ...(resolvedMove.destinationParent?.kind === "folder"
      ? []
      : [
          await requireFileGrant(
            deps.fileAccess,
            input.userId,
            containerOf(resolvedMove.destination),
            "edit",
          ),
        ]),
  ];
  return withEditGrants(deps.fileAccess, grants, () =>
    commitContextMove({
      port,
      userId: input.userId,
      move: resolvedMove,
      resolveDestinationLocator,
      authorizeDestination: resolvedMove.destinationParent
        ? async (uri) => {
            const destination = await resolveDestinationLocator(uri);
            const grant = await deps.fileAccess.authorize(
              { accountId: input.userId as UserId },
              containerOf(destination),
              "edit",
            );
            return (
              !isFileAccessDenied(grant) &&
              (await deps.fileAccess.confirmEdit([grant])).length === 0
            );
          }
        : undefined,
    }),
  );
}
