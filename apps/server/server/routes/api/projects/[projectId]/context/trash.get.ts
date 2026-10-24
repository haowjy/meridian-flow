/** List the project's restorable deleted documents. */
import type { ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event): Promise<ListDocumentTrashResponse> => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  return { documents: [...(await app.documentTrash.list(projectId))] };
});
