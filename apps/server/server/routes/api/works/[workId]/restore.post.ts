/** Restores a soft-deleted Work without resurrecting any client working set. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireWorkOwner, restoreWork } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../lib/command-route.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { runWorkCommand } from "../../../../lib/work-command.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const { commandId, body } = splitCommandBody(await readBody(event));
  const owned = await requireWorkOwner(
    { works: app.workRepo, projects: app.projectRepo },
    workId,
    user.userId,
    { includeSoftDeleted: true },
  );
  const work = await runWorkCommand(
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
      return { work: after, ...(!changed && { already: "active" }) };
    },
  );
  if (!work) throw new Error("A restore answers its Work");
  app.projectWakeHub.publish({ type: "project-chats-hint", projectId: work.projectId });
  return serializeTransport(work);
});
