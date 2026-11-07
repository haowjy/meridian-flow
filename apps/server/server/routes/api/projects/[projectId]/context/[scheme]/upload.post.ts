/**
 * Transport adapter for starting an authoritative upload (a chat attach, or a file dropped into a
 * document): reserves it and returns a signed PUT
 * for the bytes. The file never passes through here; `upload/finish` reads it back from the store.
 */

import type { StartUploadInput, UploadStart } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, readBody, setResponseStatus } from "nitro/h3";
import { resolveContextRoute } from "./_helpers.js";
import { uploadDestination, uploadErrorToHttp } from "./upload/_shared.js";

export default defineEventHandler(async (event): Promise<UploadStart> => {
  const route = await resolveContextRoute(event);
  const { app, userId, edit } = route;
  const body = (await readBody<Partial<StartUploadInput>>(event)) ?? {};
  const { intakeId, filename, sizeBytes, mimeType } = body;
  if (typeof intakeId !== "string" || !intakeId || typeof filename !== "string" || !filename)
    throw createError({ statusCode: 400, message: "intakeId and filename are required" });
  const destination = uploadDestination(route, getQuery(event).chatId, intakeId);
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw createError({ statusCode: 400, message: "sizeBytes must be a whole number of bytes" });
  const result = await edit([destination.container], () =>
    app.uploadIntake.start({
      intakeId,
      actorUserId: userId,
      owner: destination.owner,
      ...("source" in destination ? { source: destination.source } : {}),
      filename,
      sizeBytes,
      mimeType: typeof mimeType === "string" ? mimeType : "",
    }),
  );
  if (!result.ok) throw uploadErrorToHttp(result.error);
  setResponseStatus(event, 201);
  return result.value;
});
