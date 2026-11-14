/** Restores a soft-deleted Work without resurrecting any client working set. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  requireWorkOwner,
  restoreWork,
  WorkRestoreConflictError,
  WorkRestoreExpiredError,
} from "../../../../domains/projects/index.js";
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
    () => restoreWork({ works: app.workRepo, workContextNotices: app.workContextNotices }, workId),
  ).catch((error: unknown) => {
    if (error instanceof WorkRestoreConflictError) {
      throw createError({ statusCode: 409, message: error.message });
    }
    if (error instanceof WorkRestoreExpiredError) {
      throw createError({
        statusCode: 410,
        statusMessage: "Work restore window expired",
        message: error.message,
        data: { code: error.code },
      });
    }
    throw error;
  });
  if (!work) throw new Error("A restore answers its Work");
  app.projectWakeHub.publish({ type: "project-chats-hint", projectId: work.projectId });
  app.projectWakeHub.publish({ type: "context-sources-hint", projectId: work.projectId });
  return serializeTransport(work);
});
