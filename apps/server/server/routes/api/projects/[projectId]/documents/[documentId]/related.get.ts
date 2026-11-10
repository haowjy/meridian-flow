/** GET /api/projects/:projectId/documents/:documentId/related: the chats that worked on a document and the pages it mentions. */
import type { DocumentRelated } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../../../lib/file-access-http.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

const MAX_CHATS = 20;

export default defineEventHandler(async (event): Promise<DocumentRelated> => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const documentId = requireRequestId(getRouterParam(event, "documentId"), "documentId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  await requireFileGrant(app.fileAccess, user.userId, documentTarget(documentId), "read");
  const [chats, linked] = await Promise.all([
    app.documentRelated.listChats({ documentId, projectId, userId: user.userId, limit: MAX_CHATS }),
    app.documentRelated.listMentions(documentId),
  ]);
  // Lists drop what the writer can't read (file-access §6).
  const access = await app.fileAccess.listAccess(
    { accountId: user.userId as UserId },
    linked.map((mention) => mention.documentId as DocumentId),
  );
  return {
    chats,
    mentions: linked.filter((mention) => access.has(mention.documentId as DocumentId)),
  };
});
