/** GET /api/projects/:projectId/documents/:documentId/properties: a document's imported frontmatter, parsed in source order. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { readDocumentPropertiesForRoute } from "../../../../../../lib/document-properties-route.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return serializeTransport(
    await readDocumentPropertiesForRoute(app, {
      userId: user.userId,
      projectId: getRouterParam(event, "projectId") ?? "",
      documentId: requireRequestId(getRouterParam(event, "documentId"), "documentId"),
    }),
  );
});
