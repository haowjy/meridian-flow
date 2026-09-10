/**
 * POST /api/projects/:projectId/context/:scheme/delete
 *
 * Recursively deletes a file or folder from a context scheme.
 * Uses the ContextPort.delete primitive which performs CAS deletion via
 * ContextTreeMover.
 */
import type { DeleteContextEntryRequest } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

function parseBody(raw: unknown): DeleteContextEntryRequest {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as { path?: unknown; expected?: unknown };
  if (!body.expected || typeof body.expected !== "object") {
    throw createError({ statusCode: 400, message: "expected target is required" });
  }
  const expected = body.expected as { kind?: unknown; documentId?: unknown };
  if (expected.kind === "folder") {
    return { path: parseContextMutationPath(body.path, "path"), expected: { kind: "folder" } };
  }
  if (expected.kind !== "file") {
    throw createError({ statusCode: 400, message: "expected file identity is required" });
  }
  return {
    path: parseContextMutationPath(body.path, "path"),
    expected: {
      kind: "file",
      documentId: requireRequestId(expected.documentId, "expected.documentId"),
    },
  };
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, authority, port } = await resolveContextRoute(event);
  const body = parseBody(await readBody(event));
  const uri = toUri(scheme, body.path, authority);
  const result = await port.delete(uri, {
    origin: { type: "human", userId },
    expected: body.expected,
  });
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
});
