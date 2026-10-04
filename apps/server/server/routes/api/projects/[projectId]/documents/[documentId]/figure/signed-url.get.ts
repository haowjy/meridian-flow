import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../../../../lib/file-access-http.js";
import { requireRequestId } from "../../../../../../../lib/request-id.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const assetDocumentId = requireRequestId(getRouterParam(event, "documentId"), "documentId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const asset = await requireFileGrant(
    app.fileAccess,
    user.userId,
    documentTarget(assetDocumentId),
    "read",
  );
  if (asset.facts.projectId !== projectId) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  const result = await app.figureAssets.getSignedFigureUrl({ projectId, assetDocumentId });
  if (!result.ok)
    throw createError({
      statusCode: result.error.code === "document_not_found" ? 404 : 502,
      message: result.error.message,
    });
  return serializeTransport(result.value);
});
