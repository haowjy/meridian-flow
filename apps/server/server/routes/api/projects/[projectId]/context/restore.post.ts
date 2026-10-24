/** Restore documents by the exact removals a writer is undoing. */
import { restoreContextDocumentsRequestSchema } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const body = restoreContextDocumentsRequestSchema.safeParse(await readBody(event));
  if (!body.success)
    throw createError({ statusCode: 400, message: "Invalid document restore request" });
  return app.restoreRemovedDocuments({
    userId: user.userId,
    projectId,
    documents: body.data.documents,
  });
});
