import type { CreateContextEntryResult } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

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
  if (body.content !== undefined && typeof body.content !== "string")
    throw createError({ statusCode: 400, message: "`content` must be a string" });
  return {
    type: body.type,
    path: parseContextMutationPath(body.path, "path"),
    content: body.content,
  };
}

export async function createContextEntry(input: {
  port: ContextPort;
  userId: string;
  scheme: Parameters<typeof toUri>[0];
  authority?: import("@meridian/contracts/context-uri").CanonicalContextAuthority;
  /** Retained in the route-core test seam; authority, never an ID, owns URI serialization. */
  workId?: string | null;
  body: CreateContextEntryBody;
}): Promise<CreateContextEntryResult> {
  const uri = toUri(input.scheme, input.body.path, input.authority);
  const options = { origin: { type: "human" as const, userId: input.userId } };
  const result =
    input.body.type === "folder"
      ? await input.port.mkdir(uri, options)
      : await input.port.createTrackedDocument(uri, input.body.content ?? "", options);
  if (!result.ok) {
    if (result.error.code === "conflict")
      return {
        status: "conflict",
        uri: result.error.uri,
        occupantKind: result.error.occupantKind,
      };
    contextErrorToHttp(result.error);
  }
  return { status: "created", ...result.value };
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, authority, port, container, edit } = await resolveContextRoute(event);
  const body = parseCreateContextEntryBody(await readBody(event));
  const result = await edit([container], () =>
    createContextEntry({ port, userId, scheme, authority, body }),
  );
  if (result.status === "conflict") setResponseStatus(event, 409);
  return result;
});
