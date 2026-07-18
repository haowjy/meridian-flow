/**
 * POST /api/projects/:projectId/context/:scheme/delete
 *
 * Deletes a file or folder (and its children) from a context scheme.
 * Uses the ContextPort.delete primitive which performs CAS deletion via
 * ContextTreeMover.
 */
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

interface DeleteBody {
  /** Path of the entry to delete (e.g. "chapter-1.md" or "notes"). */
  path: string;
}

function parseBody(raw: unknown): DeleteBody {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Partial<DeleteBody>;
  return { path: parseContextMutationPath(body.path, "path") };
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, workId, port } = await resolveContextRoute(event);
  const body = parseBody(await readBody(event));
  const uri = toUri(scheme, body.path, workId);
  const result = await port.delete(uri, { origin: { type: "human", userId } });
  if (!result.ok) contextErrorToHttp(result.error);
  return { ok: true as const };
});
