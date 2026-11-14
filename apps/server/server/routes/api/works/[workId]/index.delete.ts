/** Soft-deletes a Work and its live children for the retention window. */
import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import {
  requireWorkOwner,
  runWorkLifecycleCommand,
  softDeleteWork,
} from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../lib/command-route.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { runWorkCommand } from "../../../../lib/work-command.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const { commandId, body } = splitCommandBody(await readBody(event));
  const work = await requireWorkOwner(
    { works: app.workRepo, projects: app.projectRepo },
    workId,
    user.userId,
    { includeSoftDeleted: true },
  );
  // A tree that changed under the delete's lock rolls the attempt back, claim included, and the
  // next attempt claims again: the retry wraps the command, not the reverse.
  await runWorkLifecycleCommand(
    (attempt) => attempt(),
    () =>
      runWorkCommand(
        app.commands,
        {
          commandId,
          userId: user.userId,
          projectId: work.projectId,
          kind: "work_delete",
          workId,
          body,
        },
        async () => {
          await softDeleteWork({ works: app.workRepo, stopThreads: app.stopThreads }, work.id);
          return undefined;
        },
      ),
  );
  // The Work's chats left the project list with it; which ones is not known here, so windows probe.
  app.projectWakeHub.publish({
    type: "project-chats-hint",
    projectId: work.projectId,
    recheckTabs: true,
  });
  app.projectWakeHub.publish({ type: "context-sources-hint", projectId: work.projectId });
  setResponseStatus(event, 204);
});
