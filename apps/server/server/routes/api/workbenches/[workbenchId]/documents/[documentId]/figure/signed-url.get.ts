import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const documentId = getRouterParam(event, "documentId") ?? "";
  await requireWorkbenchOwner({ workbenches: app.workbenchRepo }, workbenchId, user.userId);
  const result = await app.figureAssets.getSignedFigureUrl({ workbenchId, documentId });
  if (!result.ok)
    throw createError({
      statusCode: result.error.code === "document_not_found" ? 404 : 502,
      message: result.error.message,
    });
  return serializeTransport(result.value);
});
