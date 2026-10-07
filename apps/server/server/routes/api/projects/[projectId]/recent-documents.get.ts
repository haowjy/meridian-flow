/** GET project recents: the writer's recently opened documents in this project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  if (!isUuid(projectId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid project ID" });
  }
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const recent = await app.recentDocuments.listForProject(projectId, user.userId);
  // Lists drop what the writer can't read (file-access §6).
  const access = await app.fileAccess.listAccess(
    { accountId: user.userId as UserId },
    recent.map((document) => document.documentId as DocumentId),
  );
  const documents = recent.filter((document) => access.has(document.documentId as DocumentId));
  return serializeTransport({ documents });
});
