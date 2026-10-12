/** GET /api/projects/:projectId/documents/:documentId/properties: a document's imported frontmatter, parsed in source order. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { parseDocumentProperties } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../../../lib/file-access-http.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const documentId = requireRequestId(getRouterParam(event, "documentId"), "documentId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const grant = await requireFileGrant(
    app.fileAccess,
    user.userId,
    documentTarget(documentId),
    "read",
  );
  if (grant.facts.projectId !== projectId) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  const stored = await app.documentProperties.findStored(documentId);
  if (!stored) throw createError({ statusCode: 404, message: "Document has no properties" });
  return serializeTransport(parseDocumentProperties(stored));
});
