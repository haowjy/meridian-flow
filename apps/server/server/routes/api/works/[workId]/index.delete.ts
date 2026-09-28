/** Soft-deletes a Work and its live children for the retention window. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { deleteWork, requireWorkOwner } from "../../../../domains/projects/index.js";
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
    await deleteWork(
      {
        works: app.workRepo,
        workContextNotices: app.workContextNotices,
        async stopThreadRun(threadId) {
          const turnId = await app.threadRuntime.readRunningTurnId(threadId);
          if (turnId) await app.runner.cancel(threadId, turnId);
        },
      },
      workId,
    );
  }
  setResponseStatus(event, 204);
});
