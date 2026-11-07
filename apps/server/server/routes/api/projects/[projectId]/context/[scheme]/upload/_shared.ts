/** Pieces the upload start and finish routes share. */
import type { ProjectId, ThreadId } from "@meridian/contracts";
import { MAX_UPLOAD_BYTES, type UploadIntakeError } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { FileTarget } from "../../../../../../../domains/file-policy/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The chat is in the query, as for every uploads route. The client mints its id at the first attach; its row may not exist until Send. */
export function uploadSubject(projectId: string, chatId: unknown) {
  if (typeof chatId !== "string" || !UUID.test(chatId))
    throw createError({ statusCode: 400, message: "chatId is required" });
  const container: FileTarget = {
    kind: "container",
    scheme: "uploads",
    owner: { scope: "chat", projectId: projectId as ProjectId, threadId: chatId as ThreadId },
  };
  return { chatId, container };
}

export function uploadErrorToHttp(error: UploadIntakeError) {
  switch (error.code) {
    case "invalid_filename":
      return createError({ statusCode: 400, message: "invalid_filename", data: error });
    case "too_large":
      return createError({
        statusCode: 413,
        message: "too_large",
        data: { limitBytes: MAX_UPLOAD_BYTES },
      });
    case "size_mismatch":
      return createError({ statusCode: 400, message: error.code });
    case "idempotency_conflict":
    case "not_uploaded":
      return createError({ statusCode: 409, message: error.code });
    case "owner_unavailable":
      return createError({ statusCode: 404, message: error.code });
    case "storage_failed":
      return createError({ statusCode: 502, message: error.code });
  }
}
