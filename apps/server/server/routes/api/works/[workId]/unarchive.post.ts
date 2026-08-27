/** Restores an archived Work to active lists. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  await requireWorkOwner({ works: app.workRepo, projects: app.projectRepo }, workId, user.userId);
  return serializeTransport(await app.workRepo.unarchive(workId));
});
