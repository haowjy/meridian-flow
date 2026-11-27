import type { CommandId } from "@meridian/contracts";
import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { findTrashTarget, setOwnedThreadTrashState } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { commandId, body } = splitCommandBody(await readBody(event));
  const { threadId, thread, projectId } = await findTrashTarget(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    getRouterParam(event, "threadId") ?? "",
    user.userId,
    body.projectId,
  );
  await runRouteCommand<{ status: "done" }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId,
      kind: "chat_delete",
      selectors: { threadId },
      body,
    },
    async () => {
      if (thread)
        await setOwnedThreadTrashState(
          {
            repos: app.threadRepos,
            projects: app.projectRepo,
            workContextNotices: app.workContextNotices,
            workAuthorityResolver: app.workAuthorityResolver,
            works: app.workRepo,
            stopThreads: app.stopThreads,
          },
          threadId,
          user.userId,
          "deleted",
        );
      return { status: "done" };
    },
    () => undefined,
  );
  app.projectWakeHub.publish({
    type: "project-chats-hint",
    projectId,
    removedChatIds: [threadId],
  });
  setResponseStatus(event, 204);
});
