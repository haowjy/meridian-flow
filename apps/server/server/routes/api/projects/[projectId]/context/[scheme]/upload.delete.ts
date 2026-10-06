/** Transport adapter for identity-bound draft upload deletion. */
import type { DeleteDraftUploadInput, DeleteDraftUploadResult } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { documentTarget, resolveContextRoute } from "./_helpers.js";

export default defineEventHandler(async (event): Promise<DeleteDraftUploadResult> => {
  const { app, scheme, userId, edit } = await resolveContextRoute(event);
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
  const { intakeId, documentId, uri, expectedRevision } = body;
  return edit([documentTarget(documentId)], () =>
    app.uploadIntake.deleteDraft({ intakeId, documentId, uri, expectedRevision }, userId),
  );
});
