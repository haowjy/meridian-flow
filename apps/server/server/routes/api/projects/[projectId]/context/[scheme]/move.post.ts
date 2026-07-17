/** Exposes ContextPort.move for cross-folder and cross-scheme writer moves. */

import type {
  MoveContextEntryRequest,
  MoveContextEntrySuccess,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import type { AppServices } from "../../../../../../lib/compose.js";
import { contextErrorToHttp, parseScheme, sanitizePath, toUri } from "./_helpers.js";

function parseFolderPath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw createError({ statusCode: 400, message: "`destinationFolderPath` is required" });
  }
  const path = raw.trim();
  if (!path) return "";
  return sanitizePath(path);
}

function parseOptionalWorkId(raw: unknown, field: "sourceWorkId" | "destinationWorkId") {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw createError({ statusCode: 400, message: `\`${field}\` must be a non-empty string` });
  }
  return raw.trim();
}

function assertWorkScope(
  scheme: ProjectContextTreeScheme,
  workId: string | undefined,
  field: "sourceWorkId" | "destinationWorkId",
): void {
  if (isWorkScopedProjectContextScheme(scheme) && !workId) {
    throw createError({ statusCode: 400, message: `\`${field}\` is required for ${scheme}` });
  }
  if (!isWorkScopedProjectContextScheme(scheme) && workId) {
    throw createError({ statusCode: 400, message: `\`${field}\` is not valid for ${scheme}` });
  }
}

export function parseMoveContextEntryBody(raw: unknown): MoveContextEntryRequest {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = raw as Partial<MoveContextEntryRequest>;
  if (typeof body.path !== "string" || body.path.trim() === "") {
    throw createError({ statusCode: 400, message: "`path` is required" });
  }
  if (!isProjectContextTreeScheme(body.destinationScheme)) {
    throw createError({ statusCode: 400, message: "`destinationScheme` is invalid" });
  }
  if (body.newName !== undefined && (typeof body.newName !== "string" || !body.newName.trim())) {
    throw createError({ statusCode: 400, message: "`newName` must be a non-empty string" });
  }
  const newName = body.newName?.trim();
  if (newName?.includes("/") || newName === "." || newName === "..") {
    throw createError({ statusCode: 400, message: "`newName` must be a single path segment" });
  }

  const sourceWorkId = parseOptionalWorkId(body.sourceWorkId, "sourceWorkId");
  const destinationWorkId = parseOptionalWorkId(body.destinationWorkId, "destinationWorkId");
  return {
    path: sanitizePath(body.path),
    destinationScheme: body.destinationScheme,
    destinationFolderPath: parseFolderPath(body.destinationFolderPath),
    ...(newName ? { newName } : {}),
    ...(sourceWorkId ? { sourceWorkId } : {}),
    ...(destinationWorkId ? { destinationWorkId } : {}),
  };
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function joinPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .join("/");
}

async function resolveMovePort(input: {
  app: AppServices;
  projectId: string;
  userId: string;
  sourceScheme: ProjectContextTreeScheme;
  body: MoveContextEntryRequest;
}): Promise<ContextPort> {
  assertWorkScope(input.sourceScheme, input.body.sourceWorkId, "sourceWorkId");
  assertWorkScope(input.body.destinationScheme, input.body.destinationWorkId, "destinationWorkId");

  const workIds = new Set(
    [input.body.sourceWorkId, input.body.destinationWorkId].filter((workId): workId is string =>
      Boolean(workId),
    ),
  );
  for (const workId of workIds) {
    const work = await input.app.workRepo.findById(workId);
    if (!work || work.deletedAt || work.projectId !== input.projectId) {
      throw createError({ statusCode: 404, message: "Work not found" });
    }
  }
  const primaryWorkId = input.body.sourceWorkId ?? input.body.destinationWorkId;
  return primaryWorkId
    ? input.app.contextPorts.forWork(primaryWorkId, input.projectId, input.userId, workIds)
    : input.app.contextPorts.forProject(input.projectId, input.userId);
}

export async function moveContextEntry(input: {
  port: ContextPort;
  userId: string;
  sourceScheme: ProjectContextTreeScheme;
  body: MoveContextEntryRequest;
}): Promise<MoveContextEntrySuccess> {
  assertWorkScope(input.sourceScheme, input.body.sourceWorkId, "sourceWorkId");
  assertWorkScope(input.body.destinationScheme, input.body.destinationWorkId, "destinationWorkId");
  const name = input.body.newName ?? basename(input.body.path);
  const destinationPath = joinPath(input.body.destinationFolderPath, name);
  const result = await input.port.move(
    toUri(input.sourceScheme, input.body.path, input.body.sourceWorkId),
    toUri(input.body.destinationScheme, destinationPath, input.body.destinationWorkId),
    { origin: { type: "human", userId: input.userId } },
  );
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    status: "moved",
    scheme: input.body.destinationScheme,
    path: destinationPath,
    name,
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const sourceScheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const body = parseMoveContextEntryBody(await readBody(event));
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const port = await resolveMovePort({
    app,
    projectId,
    userId: user.userId,
    sourceScheme,
    body,
  });
  return moveContextEntry({ port, userId: user.userId, sourceScheme, body });
});
