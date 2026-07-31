/** DELETE /api/threads/:threadId/uploads/:documentId: soft-delete one attached upload. */

import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { deleteThreadUpload } from "../../../../../domains/context/index.js";
import { requireThreadOwner } from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { contextErrorToHttp } from "../../../../../lib/context-error-http.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const documentId = getRouterParam(event, "documentId") ?? "";
  await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );

  const result = await deleteThreadUpload(
    {
      repos: app.repos,
      contextPorts: app.contextPorts,
      uploadDocuments: app.uploadDocuments,
    },
    { threadId, documentId, userId: user.userId },
  );
  if (!result.ok) {
    if (result.error.code === "not_found") {
      throw createError({ statusCode: 404, message: "Upload not found" });
    }
    contextErrorToHttp(result.error.context);
  }
  return { ok: true as const };
});
