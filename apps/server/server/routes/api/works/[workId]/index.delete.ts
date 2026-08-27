/** Soft-deletes an empty Work, preserving D17's conversation and draft guards. */
import { createError, defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireWorkOwner, WorkDeleteBlockedError } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const work = await requireWorkOwner(
    { works: app.workRepo, projects: app.projectRepo },
    workId,
    user.userId,
    { includeSoftDeleted: true },
  );
  if (!work.deletedAt) {
    try {
      await app.workRepo.softDelete(workId);
    } catch (error) {
      if (error instanceof WorkDeleteBlockedError) {
        throw createError({ statusCode: 409, message: error.message });
      }
      throw error;
    }
  }
  setResponseStatus(event, 204);
});
