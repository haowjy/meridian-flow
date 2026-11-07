/** GET /api/projects/:projectId/documents/:documentId/read: a document's markdown, or a signed URL to its bytes. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleContextReadRequest } from "../../../../../../lib/context-read-route.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return serializeTransport(
    await handleContextReadRequest(
      {
        fileAccess: app.fileAccess,
        projectRepo: app.projectRepo,
        availability: app.projectContextAvailability,
        liveDocuments: app.liveDocuments,
        documentSync: app.documentSync,
        objectStore: app.objectStore,
        eventSink: app.eventSink,
      },
      {
        projectId: getRouterParam(event, "projectId") ?? "",
        userId: user.userId,
        documentId: requireRequestId(getRouterParam(event, "documentId"), "documentId"),
      },
    ),
  );
});
