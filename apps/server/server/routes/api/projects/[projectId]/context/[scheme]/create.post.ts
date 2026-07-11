import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import { contextErrorToHttp, resolveContextRoute, sanitizePath, toUri } from "./_helpers.js";

interface CreateContextEntryBody {
  type: "file" | "folder";
  path: string;
  content?: string;
}
export function parseCreateContextEntryBody(raw: unknown): CreateContextEntryBody {
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

export async function createContextEntry(input: {
  port: ContextPort;
  userId: string;
  scheme: Parameters<typeof toUri>[0];
  workId: string | null;
  body: CreateContextEntryBody;
}) {
  const uri = toUri(input.scheme, input.body.path, input.workId);
  if (input.body.type === "folder") {
    const result = await input.port.mkdir(uri, {
      origin: { type: "human", userId: input.userId },
    });
    if (!result.ok) contextErrorToHttp(result.error);
    return { status: "created" as const };
  }

  const result = await input.port.createTrackedDocument(uri, input.body.content ?? "", {
    origin: { type: "human", userId: input.userId },
  });
  if (!result.ok) {
    if (result.error.code === "conflict") return { status: "conflict" as const, uri };
    contextErrorToHttp(result.error);
  }
  return { status: "created" as const, documentId: result.value.documentId };
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, workId, port } = await resolveContextRoute(event);
  const result = await createContextEntry({
    port,
    userId,
    scheme,
    workId,
    body: parseCreateContextEntryBody(await readBody(event)),
  });
  if (result.status === "conflict") setResponseStatus(event, 409);
  return result;
});
