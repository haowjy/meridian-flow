/** Exposes ContextPort.move for cross-folder and cross-scheme writer moves. */

import {
  type ContextEntryValidationError,
  validateContextEntryName,
  validateContextEntryPath,
} from "@meridian/contracts/context-entry-validation";
import type {
  MoveContextEntryRequest,
  MoveContextEntryResult,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import {
  type ContextPort,
  parseUnifiedContextUri,
} from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import type { AppServices } from "../../../../../../lib/compose.js";
import { contextErrorToHttp, parseScheme, toUri } from "./_helpers.js";

function validationError(field: string, error: ContextEntryValidationError): never {
  throw createError({
    statusCode: 400,
    message: `Invalid \`${field}\`: ${error.reason}`,
    data: { field, reason: error.reason, segment: error.segment, character: error.character },
  });
}

function parsePath(raw: unknown, field: "path" | "destinationFolderPath", allowRoot = false) {
  if (typeof raw !== "string") {
    throw createError({ statusCode: 400, message: `\`${field}\` is required` });
  }
  const result = validateContextEntryPath(raw, { allowRoot });
  if (!result.ok) validationError(field, result);
  return result.value;
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
  if (!isProjectContextTreeScheme(body.destinationScheme)) {
    throw createError({ statusCode: 400, message: "`destinationScheme` is invalid" });
  }
  let newName: string | undefined;
  if (body.newName !== undefined) {
    if (typeof body.newName !== "string") {
      throw createError({ statusCode: 400, message: "`newName` must be a string" });
    }
    const result = validateContextEntryName(body.newName);
    if (!result.ok) validationError("newName", result);
    newName = result.value;
  }

  const sourceWorkId = parseOptionalWorkId(body.sourceWorkId, "sourceWorkId");
  const destinationWorkId = parseOptionalWorkId(body.destinationWorkId, "destinationWorkId");
  return {
    path: parsePath(body.path, "path"),
    destinationScheme: body.destinationScheme,
    destinationFolderPath: parsePath(body.destinationFolderPath, "destinationFolderPath", true),
    ...(newName ? { newName } : {}),
    ...(sourceWorkId ? { sourceWorkId } : {}),
    ...(destinationWorkId ? { destinationWorkId } : {}),
  };
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
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
}): Promise<MoveContextEntryResult> {
  assertWorkScope(input.sourceScheme, input.body.sourceWorkId, "sourceWorkId");
  assertWorkScope(input.body.destinationScheme, input.body.destinationWorkId, "destinationWorkId");
  const name = input.body.newName ?? basename(input.body.path);
  const destinationPath = joinPath(input.body.destinationFolderPath, name);
  const result = await input.port.commitWriterLocation(
    toUri(input.sourceScheme, input.body.path, input.body.sourceWorkId),
    toUri(input.body.destinationScheme, destinationPath, input.body.destinationWorkId),
    { origin: { type: "human", userId: input.userId } },
  );
  if (!result.ok) {
    if (result.error.code === "conflict") {
      const collision = parseUnifiedContextUri(result.error.uri);
      if (!collision.ok) contextErrorToHttp(collision.error);
      return {
        status: "conflict",
        collision: {
          scheme: collision.value.scheme,
          path: collision.value.path,
          ...(collision.value.authority ? { workId: collision.value.authority } : {}),
        },
      };
    }
    contextErrorToHttp(result.error);
  }
  return {
    status: "moved",
    scheme: input.body.destinationScheme,
    path: result.value.destinationPath,
    name: basename(result.value.destinationPath),
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const sourceScheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const body = parseMoveContextEntryBody(await readBody(event));
  const port = await resolveMovePort({
    app,
    projectId,
    userId: user.userId,
    sourceScheme,
    body,
  });
  const result = await moveContextEntry({ port, userId: user.userId, sourceScheme, body });
  if (result.status === "conflict") setResponseStatus(event, 409);
  return result;
});
