/** Pieces the upload start and finish routes share. */
import type { ProjectId, ThreadId } from "@meridian/contracts";
import { MAX_UPLOAD_BYTES, type UploadIntakeError } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { UploadSourceDestination } from "../../../../../../../domains/context/uploads/index.js";
import type { FileTarget } from "../../../../../../../domains/file-policy/index.js";
import type { ResolvedContextRoute } from "../_helpers.js";

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

/**
 * Where an upload start or finish lands. `uploads` is a chat's attach. Any other source takes a
 * file dropped into a document, into that source's `assets/`; the client mints the file's
 * document id and sends it as the intake id, so the link stands in the document before the file.
 */
export function uploadDestination(route: ResolvedContextRoute, chatId: unknown, intakeId: string) {
  const { projectId } = route;
  if (route.scheme === "uploads") {
    const subject = uploadSubject(projectId, chatId);
    return {
      owner: { kind: "chat" as const, projectId, chatId: subject.chatId },
      container: subject.container,
    };
  }
  if (!UUID.test(intakeId))
    throw createError({ statusCode: 400, message: "intakeId must be the file's new document id" });
  const source: UploadSourceDestination = { scheme: route.scheme, port: route.port };
  return { owner: { kind: "source" as const, projectId }, container: route.container, source };
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
