/**
 * POST /api/projects/:projectId/context/:scheme/rename
 *
 * Renames a file or folder within a scheme by moving it to a new path under
 * the same parent directory. Uses the ContextPort.move primitive.
 */

import type {
  RenameContextEntryRequest,
  RenameContextEntrySuccess,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "../../../../../../lib/context-mutation-validation.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

function parseBody(raw: unknown): RenameContextEntryRequest {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Partial<RenameContextEntryRequest>;
  return {
    path: parseContextMutationPath(body.path, "path"),
    newName: parseContextMutationName(body.newName, "newName"),
  };
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, workId, port } = await resolveContextRoute(event);
  const body = parseBody(await readBody(event));

  // Build the destination path: same parent directory, new basename.
  const segments = body.path.split("/").filter(Boolean);
  segments.pop();
  const destinationPath = [...segments, body.newName].join("/");

  const sourceUri = toUri(scheme, body.path, workId);
  const destinationUri = toUri(scheme, destinationPath, workId);
  const result = await port.move(sourceUri, destinationUri, {
    origin: { type: "human", userId },
  });
  if (!result.ok) contextErrorToHttp(result.error);
  return { status: "renamed" } satisfies RenameContextEntrySuccess;
});
