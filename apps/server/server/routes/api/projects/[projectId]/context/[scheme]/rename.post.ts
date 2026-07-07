/**
 * POST /api/projects/:projectId/context/:scheme/rename
 *
 * Renames a file or folder within a scheme by moving it to a new path under
 * the same parent directory. Uses the ContextPort.move primitive.
 */
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

interface RenameBody {
  /** Current path of the entry (e.g. "chapter-1.md" or "notes/ideas"). */
  path: string;
  /** New name (basename only, no slashes). */
  newName: string;
}

function parseBody(raw: unknown): RenameBody {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Partial<RenameBody>;
  if (typeof body.path !== "string" || body.path.trim() === "")
    throw createError({ statusCode: 400, message: "`path` is required" });
  if (typeof body.newName !== "string" || body.newName.trim() === "")
    throw createError({ statusCode: 400, message: "`newName` is required" });
  const newName = body.newName.trim();
  if (newName.includes("/"))
    throw createError({ statusCode: 400, message: "`newName` must not contain '/'" });
  if (newName === "." || newName === "..")
    throw createError({ statusCode: 400, message: "`newName` must not be '.' or '..'" });
  return { path: body.path.trim(), newName };
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
  return { ok: true as const, path: destinationPath };
});
