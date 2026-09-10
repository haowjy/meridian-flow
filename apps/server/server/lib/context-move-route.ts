/** Plain-data orchestration for committing a writer-visible context identity. */

import type { MoveContextEntryResult } from "@meridian/contracts/protocol";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
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
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import { contextErrorToHttp } from "./context-error-http.js";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "./context-mutation-validation.js";

export interface ContextMoveRouteDeps {
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

export type ContextMoveLocator = ProjectLocator | NoWorkLocator | WorkLocator;

export interface ParsedContextMove {
  source: ContextMoveLocator;
  destination: ContextMoveLocator;
  name?: string;
}

type ResolvedWorkLocator = Omit<WorkLocator, "workId"> & { authority: ResolvedWorkAuthority };
export type ResolvedContextMoveLocator = ProjectLocator | NoWorkLocator | ResolvedWorkLocator;
export type ResolvedContextMove = {
  source: ResolvedContextMoveLocator;
  destination: ResolvedContextMoveLocator;
  name?: string;
};

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
}): ContextMoveLocator {
  if (!isProjectContextTreeScheme(input.scheme)) {
    throw createError({ statusCode: 400, message: "Context scheme is invalid" });
  }
  if (isWorkScopedProjectContextScheme(input.scheme)) {
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

export function parseContextMove(input: {
  sourceScheme: unknown;
  body: unknown;
}): ParsedContextMove {
  if (!input.body || typeof input.body !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = input.body as Record<string, unknown>;
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
    source: parseLocator({
      scheme: input.sourceScheme,
      path: sourcePath,
      workId: parseWorkId(body.sourceWorkId, "sourceWorkId"),
      workIdField: "sourceWorkId",
    }),
    destination: parseLocator({
      scheme: body.destinationScheme,
      path: destinationFolderPath,
      workId: parseWorkId(body.destinationWorkId, "destinationWorkId"),
      workIdField: "destinationWorkId",
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
  if (locator.scope === "work") {
    return projectBrowseContextUri(locator.scheme, path, locator.authority);
  }
  if (locator.scope === "none") {
    return projectBrowseContextUri(locator.scheme, path, { kind: "none" });
  }
  return projectBrowseContextUri(locator.scheme, path);
}

export async function commitContextMove(input: {
  port: ContextPort;
  userId: string;
  move: ResolvedContextMove;
}): Promise<MoveContextEntryResult> {
  const name = input.move.name ?? basename(input.move.source.path);
  const destinationPath = joinPath(input.move.destination.path, name);
  const result = await input.port.commitWriterLocation(
    locatorUri(input.move.source, input.move.source.path),
    locatorUri(input.move.destination, destinationPath),
    { origin: { type: "human", userId: input.userId } },
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
      const destination = input.move.destination;
      const authorityMatches =
        destination.scope === "project"
          ? collision.value.authority.kind === "contextual"
          : destination.scope === "none"
            ? collision.value.authority.kind === "none"
            : collision.value.authority.kind === "work" &&
              collision.value.authority.workSlug === destination.authority.workSlug;
      if (
        collision.value.scheme !== destination.scheme ||
        collision.value.path !== destinationPath ||
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
          destination.scope === "work"
            ? {
                scheme: destination.scheme,
                path: collision.value.path,
                authority: {
                  kind: "work",
                  workId: destination.authority.workId,
                  workSlug: destination.authority.workSlug,
                },
              }
            : destination.scope === "none"
              ? {
                  scheme: destination.scheme,
                  path: collision.value.path,
                  authority: { kind: "none" },
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
  return {
    status: "moved",
    scheme: input.move.destination.scheme,
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
  async function resolveLocator(locator: ContextMoveLocator): Promise<ResolvedContextMoveLocator> {
    if (locator.scope !== "work") return locator;
    const authority = await deps.workAuthorityResolver.byId(input.projectId, locator.workId);
    if (!authority) throw createError({ statusCode: 404, message: "Work not found" });
    return { scope: "work", scheme: locator.scheme, path: locator.path, authority };
  }
  const resolvedMove: ResolvedContextMove = {
    source: await resolveLocator(move.source),
    destination: await resolveLocator(move.destination),
    ...(move.name ? { name: move.name } : {}),
  };
  const workIds = new Set(
    [move.source, move.destination]
      .filter((locator): locator is WorkLocator => locator.scope === "work")
      .map((locator) => locator.workId),
  );
  const primaryWorkId = move.source.scope === "work" ? move.source.workId : [...workIds][0];
  const works = await deps.workRepo.listByProject(input.projectId);
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
  if (!port) throw createError({ statusCode: 404, message: "Work not found" });
  return commitContextMove({ port, userId: input.userId, move: resolvedMove });
}
