import { serializeTransport } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireWorkOwner, restoreWork } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../lib/command-route.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { already, runWorkCommand, workAnswer } from "../../../../lib/work-command.js";
import { throwWorkMutationHttpError } from "../../../../lib/work-http.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const { commandId, body } = splitCommandBody(await readBody(event));
  try {
    const owned = await requireWorkOwner(
      { works: app.workRepo, projects: app.projectRepo },
      workId,
      user.userId,
      { includeSoftDeleted: true },
    );
    const answer = await runWorkCommand(
      app.commands,
      {
        commandId,
        userId: user.userId,
        projectId: owned.projectId,
        kind: "work_restore",
        workId,
        body,
      },
      async () => {
        const { after, changed } = await restoreWork(
          { works: app.workRepo, workContextNotices: app.workContextNotices },
          workId,
        );
        return {
          work: after,
          ...(!changed && already(isWorkArchived(after) ? "archived" : "active")),
        };
      },
    );
    const restored = workAnswer(answer);
    app.projectWakeHub.publish({ type: "project-chats-hint", projectId: restored.projectId });
    return serializeTransport(restored);
  } catch (error) {
    throwWorkMutationHttpError(error);
  }
});
