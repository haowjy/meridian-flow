/**
 * Transport adapter for authoritative UploadIntake. The file is the request body, streamed; the
 * name and chat ride in the query and the type in Content-Type.
 */

import { Readable } from "node:stream";
import type { ProjectId, ThreadId } from "@meridian/contracts";
import { MAX_UPLOAD_BYTES, type UploadIntakeResult } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getQuery,
  getRequestHeader,
  setResponseStatus,
} from "nitro/h3";
import type { FileTarget } from "../../../../../../domains/file-policy/index.js";
import { resolveContextRoute } from "./_helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default defineEventHandler(async (event): Promise<UploadIntakeResult> => {
  const { app, userId, projectId, scheme, edit } = await resolveContextRoute(event);
  if (scheme !== "uploads")
    throw createError({ statusCode: 400, message: "Upload intake requires uploads" });
  const query = getQuery(event);
  const { intakeId, filename, chatId } = query;
  // The client mints the chat id at the first attach; the chat's row may not exist until Send.
  if (typeof intakeId !== "string" || !intakeId || typeof filename !== "string" || !filename)
    throw createError({ statusCode: 400, message: "intakeId and filename are required" });
  if (typeof chatId !== "string" || !UUID.test(chatId))
    throw createError({ statusCode: 400, message: "chatId is required" });
  const length = getRequestHeader(event, "content-length");
  if (!length || !/^\d+$/.test(length))
    throw createError({ statusCode: 411, message: "Content-Length is required" });
  const sizeBytes = Number(length);
  const body = event.req.body;
  if (!body) throw createError({ statusCode: 400, message: "The file is the request body" });
  const owner = { kind: "chat" as const, projectId, chatId };
  const container: FileTarget = {
    kind: "container",
    scheme: "uploads",
    owner: { scope: "chat", projectId: projectId as ProjectId, threadId: chatId as ThreadId },
  };
  const result = await edit([container], () =>
    app.uploadIntake.intake({
      intakeId,
      actorUserId: userId,
      owner,
      filename,
      mimeType: getRequestHeader(event, "content-type") ?? "application/octet-stream",
      sizeBytes,
      body: Readable.fromWeb(body as never),
    }),
  );
  if (!result.ok) {
    if (result.error.code === "invalid_filename") {
      throw createError({ statusCode: 400, message: "invalid_filename", data: result.error });
    }
    if (result.error.code === "too_large") {
      throw createError({
        statusCode: 413,
        message: "too_large",
        data: { limitBytes: MAX_UPLOAD_BYTES },
      });
    }
    const statusCode =
      result.error.code === "idempotency_conflict"
        ? 409
        : result.error.code === "owner_unavailable"
          ? 404
          : result.error.code === "size_mismatch"
            ? 400
            : 502;
    throw createError({ statusCode, message: result.error.code });
  }
  setResponseStatus(event, 201);
  return result.value;
});
