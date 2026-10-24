/** Read one restorable deleted document with its last settled text. */
import type { DocumentId } from "@meridian/contracts";
import type { GetDocumentTrashResponse } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event): Promise<GetDocumentTrashResponse> => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const documentId = requireRequestId(
    getRouterParam(event, "documentId"),
    "documentId",
  ) as DocumentId;
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const document = await app.documentTrash.read(projectId, documentId);
  if (!document) {
    if (await app.documentTrash.wasPurged(projectId, documentId))
      throw createError({ statusCode: 410, statusMessage: "Document no longer available" });
    throw createError({ statusCode: 404, statusMessage: "Document not in trash" });
  }
  return document;
});
