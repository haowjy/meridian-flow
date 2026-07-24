import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../../lib/request-id.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const documentId = requireRequestId(getRouterParam(event, "documentId"), "documentId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const result = await app.figureAssets.getSignedFigureUrl({ projectId, documentId });
  if (!result.ok)
    throw createError({
      statusCode: result.error.code === "document_not_found" ? 404 : 502,
      message: result.error.message,
    });
  return serializeTransport(result.value);
});
