/** Multipart transport adapter for authoritative UploadIntake. */

import type { ProjectId, ThreadId } from "@meridian/contracts";
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getQuery,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import type { FileTarget } from "../../../../../../domains/file-policy/index.js";
import { resolveContextRoute } from "./_helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(parts: Awaited<ReturnType<typeof readMultipartFormData>>, name: string): string {
  const value = parts?.find((part) => part.name === name && !part.filename)?.data;
  return value ? Buffer.from(value).toString("utf8").trim() : "";
}

export default defineEventHandler(async (event): Promise<UploadIntakeResult> => {
  const { app, userId, projectId, scheme, edit } = await resolveContextRoute(event);
  if (scheme !== "uploads")
    throw createError({ statusCode: 400, message: "Upload intake requires uploads" });
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file" && part.filename);
  if (!file?.filename)
    throw createError({ statusCode: 400, message: "multipart field 'file' is required" });
  const intakeId = field(parts, "intakeId");
  const byteDigest = field(parts, "byteDigest").toLowerCase();
  if (!intakeId || !/^[0-9a-f]{64}$/.test(byteDigest)) {
    throw createError({ statusCode: 400, message: "intakeId and SHA-256 byteDigest are required" });
  }
  // The client mints the chat id at the first attach; the chat's row may not exist until Send.
  const chatId = getQuery(event).chatId;
  if (typeof chatId !== "string" || !UUID.test(chatId))
    throw createError({ statusCode: 400, message: "chatId is required" });
  const owner = { kind: "chat" as const, projectId, chatId };
  const container: FileTarget = {
    kind: "container",
    scheme: "uploads",
    owner: { scope: "chat", projectId: projectId as ProjectId, threadId: chatId as ThreadId },
  };
  const filename = file.filename;
  const result = await edit([container], () =>
    app.uploadIntake.intake({
      intakeId,
      actorUserId: userId,
      owner,
      filename,
      mimeType: file.type ?? "application/octet-stream",
      byteDigest,
      bytes: file.data,
    }),
  );
  if (!result.ok) {
    if (result.error.code === "invalid_filename") {
      throw createError({ statusCode: 400, message: "invalid_filename", data: result.error });
    }
    const statusCode =
      result.error.code === "idempotency_conflict"
        ? 409
        : result.error.code === "owner_unavailable"
          ? 404
          : 502;
    throw createError({ statusCode, message: result.error.code });
  }
  setResponseStatus(event, 201);
  return result.value;
});
