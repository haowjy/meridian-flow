/** Archives a Work as a pure visibility change. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkOwner, setWorkArchived } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { throwWorkMutationHttpError } from "../../../../lib/work-http.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  try {
    await requireWorkOwner({ works: app.workRepo, projects: app.projectRepo }, workId, user.userId);
    const transition = await setWorkArchived(
      { works: app.workRepo, workContextNotices: app.workContextNotices },
      workId,
      true,
    );
    return serializeTransport(transition.after);
  } catch (error) {
    throwWorkMutationHttpError(error);
  }
});
