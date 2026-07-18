/** Materializes a client-minted untitled document without seeding its Yjs content. */
import { createError, defineEventHandler, readBody } from "nitro/h3";
import type { ContextPort, ContextScheme } from "../../../../../../domains/context/index.js";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

interface CreateUntitledBody {
  documentId: string;
  folderPath?: string;
}

export function parseCreateUntitledBody(raw: unknown): CreateUntitledBody {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = raw as Partial<CreateUntitledBody>;
  if (typeof body.documentId !== "string" || body.documentId.trim() === "") {
    throw createError({ statusCode: 400, message: "`documentId` is required" });
  }
  if (body.folderPath !== undefined && typeof body.folderPath !== "string") {
    throw createError({ statusCode: 400, message: "`folderPath` must be a string" });
  }
  const folderPath =
    body.folderPath === undefined
      ? undefined
      : parseContextMutationPath(body.folderPath, "folderPath", { allowRoot: true });
  return {
    documentId: body.documentId,
    ...(folderPath ? { folderPath } : {}),
  };
}

export async function createUntitledContextDocument(input: {
  port: ContextPort;
  userId: string;
  scheme: ContextScheme;
  workId: string | null;
  body: CreateUntitledBody;
}) {
  const homeUri = toUri(input.scheme, input.body.folderPath ?? "", input.workId);
  const result = await input.port.createUntitledDocument(homeUri, {
    documentId: input.body.documentId,
    origin: { type: "human", userId: input.userId },
  });
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value.status === "created"
    ? {
        ...result.value,
        scheme: input.scheme,
        ...(input.workId ? { workId: input.workId } : {}),
      }
    : result.value;
}

export default defineEventHandler(async (event) => {
  const { userId, scheme, workId, port } = await resolveContextRoute(event, {
    recoverAcrossProject: true,
  });
  return createUntitledContextDocument({
    port,
    userId,
    scheme,
    workId,
    body: parseCreateUntitledBody(await readBody(event)),
  });
});
