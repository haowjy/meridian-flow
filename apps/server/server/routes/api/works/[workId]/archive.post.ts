/** Archives a Work as a pure visibility change. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireWorkOwner, setWorkArchived } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../lib/command-route.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { runWorkCommand } from "../../../../lib/work-command.js";
import { throwWorkMutationHttpError } from "../../../../lib/work-http.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const { commandId, body } = splitCommandBody(await readBody(event));
  try {
    const work = await requireWorkOwner(
      { works: app.workRepo, projects: app.projectRepo },
      workId,
      user.userId,
    );
    const archived = await runWorkCommand(
      app.commands,
      {
        commandId,
        userId: user.userId,
        projectId: work.projectId,
        kind: "work_archive",
        workId,
        body,
      },
      async () =>
        (
          await setWorkArchived(
            { works: app.workRepo, workContextNotices: app.workContextNotices },
            workId,
            true,
          )
        ).after,
    );
    return serializeTransport(archived);
  } catch (error) {
    throwWorkMutationHttpError(error);
  }
});
