/**
 * Transport adapter for finishing an upload: the browser has PUT the bytes, and this reads them
 * back from the store, names the file and makes it visible. Calling it again is safe.
 */

import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, readBody } from "nitro/h3";
import { resolveContextRoute } from "../_helpers.js";
import { uploadErrorToHttp, uploadIntakeId, uploadSubject } from "./_shared.js";

export default defineEventHandler(async (event): Promise<UploadIntakeResult> => {
  const { app, userId, projectId, scheme, edit } = await resolveContextRoute(event);
  if (scheme !== "uploads")
    throw createError({ statusCode: 400, message: "Upload intake requires uploads" });
  const body = await readBody<{ intakeId?: unknown }>(event);
  const intakeId = uploadIntakeId(body?.intakeId);
  const subject = uploadSubject(projectId, getQuery(event).chatId);
  const result = await edit([subject.container], () =>
    app.uploadIntake.finish({
      intakeId,
      actorUserId: userId,
      owner: { kind: "chat", projectId, chatId: subject.chatId },
    }),
  );
  if (!result.ok) throw uploadErrorToHttp(result.error);
  return result.value;
});
