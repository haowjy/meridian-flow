import { createError, defineEventHandler, readBody } from "nitro/h3";
import { contextErrorToHttp, resolveContextRoute, sanitizePath, toUri } from "./_helpers.js";

interface CreateContextEntryBody {
  type: "file" | "folder";
  path: string;
  content?: string;
}
function parseBody(raw: unknown): CreateContextEntryBody {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Partial<CreateContextEntryBody>;
  if (body.type !== "file" && body.type !== "folder")
    throw createError({ statusCode: 400, message: "`type` must be 'file' or 'folder'" });
  if (typeof body.path !== "string" || body.path.trim() === "")
    throw createError({ statusCode: 400, message: "`path` is required" });
  if (body.content !== undefined && typeof body.content !== "string")
    throw createError({ statusCode: 400, message: "`content` must be a string" });
  return { type: body.type, path: sanitizePath(body.path), content: body.content };
}
export default defineEventHandler(async (event) => {
  const { userId, scheme, workId, port } = await resolveContextRoute(event);
  const body = parseBody(await readBody(event));
  const uri = toUri(scheme, body.path, workId);
  if (body.type === "folder") {
    const result = await port.mkdir(uri, { origin: { type: "human", userId } });
    if (!result.ok) contextErrorToHttp(result.error);
    return { ok: true as const };
  }

  const result = await port.write(uri, body.content ?? "", {
    origin: { type: "human", userId },
  });
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    ok: true as const,
    documentId: result.value.documentId,
    content: result.value.markdown,
  };
});
