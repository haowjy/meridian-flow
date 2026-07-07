/**
 * POST /api/projects/:projectId/context/:scheme/delete
 *
 * Deletes a file or folder (and its children) from a context scheme.
 * Uses the ContextPort.delete primitive which performs CAS deletion via
 * ContextTreeMover.
 */
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

interface DeleteBody {
  /** Path of the entry to delete (e.g. "chapter-1.md" or "notes"). */
  path: string;
}

function parseBody(raw: unknown): DeleteBody {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Partial<DeleteBody>;
  if (typeof body.path !== "string" || body.path.trim() === "")
    throw createError({ statusCode: 400, message: "`path` is required" });
  const path = body.path.trim();
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0)
    throw createError({ statusCode: 400, message: "`path` must name a non-root entry" });
  return { path };
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, workId, port } = await resolveContextRoute(event);
  const body = parseBody(await readBody(event));
  const uri = toUri(scheme, body.path, workId);
  const result = await port.delete(uri, { origin: { type: "human", userId } });
  if (!result.ok) contextErrorToHttp(result.error);
  return { ok: true as const };
});
