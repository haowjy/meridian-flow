/** Deletes a chat's unused upload by its document id (the node id the list holds). */
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
  if (typeof body.documentId !== "string") {
    throw createError({ statusCode: 400, message: "documentId is required" });
  }
  // The chat's uploads container, not the document: an upload the writer deletes before it
  // finishes has no document yet.
  const subject = uploadSubject(projectId, getQuery(event).chatId);
  return edit([subject.container], () =>
    app.uploadIntake.deleteDraft({ documentId: body.documentId as string }, userId, {
      kind: "chat",
      projectId,
      chatId: subject.chatId,
    }),
  );
});
