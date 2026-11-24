import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const chatId = requireRequestId(getQuery(event).chatId, "chatId");
  return serializeTransport(await app.chatUploads.list(projectId, chatId));
});
