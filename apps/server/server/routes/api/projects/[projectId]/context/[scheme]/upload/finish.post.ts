/**
 * Transport adapter for finishing an upload: the browser has PUT the bytes, and this reads them
 * back from the store, names the file and makes it visible. Calling it again is safe.
 */

import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery, readBody } from "nitro/h3";
import { resolveContextRoute } from "../_helpers.js";
import { uploadDestination, uploadErrorToHttp, uploadIntakeId } from "./_shared.js";

export default defineEventHandler(async (event): Promise<UploadIntakeResult> => {
  const route = await resolveContextRoute(event);
  const { app, userId, edit } = route;
  const body = await readBody<{ intakeId?: unknown }>(event);
  const intakeId = uploadIntakeId(body?.intakeId);
  const destination = uploadDestination(route, getQuery(event).chatId);
  const result = await edit([destination.container], () =>
    app.uploadIntake.finish({
      intakeId,
      actorUserId: userId,
      owner: destination.owner,
      ...("source" in destination ? { source: destination.source } : {}),
    }),
  );
  if (!result.ok) throw uploadErrorToHttp(result.error);
  return result.value;
});
