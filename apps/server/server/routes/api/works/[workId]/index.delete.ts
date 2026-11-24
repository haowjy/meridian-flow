import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import {
  requireWorkOwner,
  runWorkLifecycleCommand,
  softDeleteWork,
} from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../lib/command-route.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { already, runWorkCommand } from "../../../../lib/work-command.js";
import { throwWorkMutationHttpError } from "../../../../lib/work-http.js";

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
  try {
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
            const { changed } = await softDeleteWork(
              { works: app.workRepo, stopThreads: app.stopThreads },
              work.id,
            );
            return changed ? {} : already("deleted");
          },
        ),
    );
  } catch (error) {
    throwWorkMutationHttpError(error);
  }
  app.projectWakeHub.publish({
    type: "project-chats-hint",
    projectId: work.projectId,
    recheckTabs: true,
  });
  setResponseStatus(event, 204);
});
