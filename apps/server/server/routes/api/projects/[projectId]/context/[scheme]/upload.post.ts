/**
 * Transport adapter for starting an authoritative upload: reserves it and returns a signed PUT
 * for the bytes. The file never passes through here; `upload/finish` reads it back from the store.
 */

import type { StartUploadInput, UploadStart } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, readBody, setResponseStatus } from "nitro/h3";
import { resolveContextRoute } from "./_helpers.js";
import { uploadErrorToHttp, uploadSubject } from "./upload/_shared.js";

export default defineEventHandler(async (event): Promise<UploadStart> => {
  const { app, userId, projectId, scheme, edit } = await resolveContextRoute(event);
  if (scheme !== "uploads")
    throw createError({ statusCode: 400, message: "Upload intake requires uploads" });
  const body = (await readBody<Partial<StartUploadInput>>(event)) ?? {};
  const { intakeId, filename, sizeBytes, mimeType } = body;
  if (typeof intakeId !== "string" || !intakeId || typeof filename !== "string" || !filename)
    throw createError({ statusCode: 400, message: "intakeId and filename are required" });
  const subject = uploadSubject(projectId, getQuery(event).chatId);
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw createError({ statusCode: 400, message: "sizeBytes must be a whole number of bytes" });
  const result = await edit([subject.container], () =>
    app.uploadIntake.start({
      intakeId,
      actorUserId: userId,
      owner: { kind: "chat", projectId, chatId: subject.chatId },
      filename,
      sizeBytes,
      mimeType: typeof mimeType === "string" ? mimeType : "",
    }),
  );
  if (!result.ok) throw uploadErrorToHttp(result.error);
  setResponseStatus(event, 201);
  return result.value;
});
