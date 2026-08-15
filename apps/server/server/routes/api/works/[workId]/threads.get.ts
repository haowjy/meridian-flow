/** Lists live conversations associated with this owned Work. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const work = await requireWorkOwner(
    { works: app.workRepo, projects: app.projectRepo },
    workId,
    user.userId,
  );
  const threads = await app.repos.threads.listByWork(work.projectId, workId);
  return serializeTransport({ threads });
});
