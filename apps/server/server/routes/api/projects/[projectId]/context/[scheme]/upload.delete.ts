/** Transport adapter for identity-bound draft upload deletion. */
import type { DeleteDraftUploadInput, DeleteDraftUploadResult } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { resolveContextRoute } from "./_helpers.js";

export default defineEventHandler(async (event): Promise<DeleteDraftUploadResult> => {
  const { app, scheme, userId } = await resolveContextRoute(event);
  if (scheme !== "uploads") {
    throw createError({ statusCode: 400, message: "Draft upload deletion requires uploads" });
  }
  const body = (await readBody<Partial<DeleteDraftUploadInput>>(event)) ?? {};
  if (
    typeof body.intakeId !== "string" ||
    typeof body.documentId !== "string" ||
    typeof body.uri !== "string" ||
    typeof body.expectedRevision !== "string"
  ) {
    throw createError({ statusCode: 400, message: "Complete upload identity is required" });
  }
  return app.uploadIntake.deleteDraft(
    {
      intakeId: body.intakeId,
      documentId: body.documentId,
      uri: body.uri,
      expectedRevision: body.expectedRevision,
    },
    userId,
  );
});
