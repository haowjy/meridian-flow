/**
 * Transport adapter for authoritative UploadIntake. The file is the request body, streamed; the
 * name and owner ride in the query and the type in Content-Type. `uploads` takes a chat's attach;
 * any other source takes a file dropped into a document, into that source's `assets/`.
 */

import { Readable } from "node:stream";
import { MAX_UPLOAD_BYTES, type UploadIntakeResult } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getQuery,
  getRequestHeader,
  setResponseStatus,
} from "nitro/h3";
import { resolveContextRoute } from "./_helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default defineEventHandler(async (event): Promise<UploadIntakeResult> => {
  const { app, userId, projectId, scheme, port, container, edit } =
    await resolveContextRoute(event);
  const query = getQuery(event);
  const { filename } = query;
  if (typeof filename !== "string" || !filename)
    throw createError({ statusCode: 400, message: "filename is required" });
  const length = getRequestHeader(event, "content-length");
  if (!length || !/^\d+$/.test(length))
    throw createError({ statusCode: 411, message: "Content-Length is required" });
  const sizeBytes = Number(length);
  const body = event.req.body;
  if (!body) throw createError({ statusCode: 400, message: "The file is the request body" });
  const common = {
    actorUserId: userId,
    filename,
    mimeType: getRequestHeader(event, "content-type") ?? "application/octet-stream",
    sizeBytes,
    body: Readable.fromWeb(body as never),
  };

  let result: Awaited<ReturnType<typeof app.uploadIntake.intake>>;
  if (scheme === "uploads") {
    // A chat attach. The client mints the chat id at the first attach; the row may not exist
    // until Send.
    const { intakeId, chatId } = query;
    if (typeof intakeId !== "string" || !intakeId)
      throw createError({ statusCode: 400, message: "intakeId and filename are required" });
    if (typeof chatId !== "string" || !UUID.test(chatId))
      throw createError({ statusCode: 400, message: "chatId is required" });
    result = await edit([container], () =>
      app.uploadIntake.intake({
        ...common,
        intakeId,
        owner: { kind: "chat", projectId, chatId },
      }),
    );
  } else {
    // A file dropped into a document: `assets/` of the document's own source. The id is the
    // client's, so the link to the file stood in the document before this request.
    const { documentId } = query;
    if (typeof documentId !== "string" || !UUID.test(documentId))
      throw createError({ statusCode: 400, message: "documentId is required" });
    result = await edit([container], () =>
      app.uploadIntake.intake({
        ...common,
        intakeId: documentId,
        owner: { kind: "source", projectId },
        source: { scheme, port, documentId },
      }),
    );
  }
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
