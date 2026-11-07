/** Transport adapter for identity-bound draft upload deletion. */
import type { DeleteDraftUploadInput, DeleteDraftUploadResult } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, readBody } from "nitro/h3";
import { resolveContextRoute } from "./_helpers.js";
import { uploadSubject } from "./upload/_shared.js";

export default defineEventHandler(async (event): Promise<DeleteDraftUploadResult> => {
  const { app, scheme, userId, projectId, edit } = await resolveContextRoute(event);
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
  // The chat's uploads container, not the document: an upload the writer deletes before it
  // finishes has no document yet.
  const subject = uploadSubject(projectId, getQuery(event).chatId);
  return edit([subject.container], () =>
    app.uploadIntake.deleteDraft({ intakeId, documentId, uri, expectedRevision }, userId),
  );
});
