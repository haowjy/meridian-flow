import type { CommandId, ProjectId } from "@meridian/contracts";
import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { requireThreadOwner, setOwnedThreadTrashState } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const { commandId, body } = splitCommandBody(await readBody(event));
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
    { includeDeleted: true },
  );
  await runRouteCommand<{ status: "done" }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId: thread.projectId as ProjectId,
      kind: "chat_delete",
      selectors: { threadId: thread.id },
      body,
    },
    async () => {
      await setOwnedThreadTrashState(
        {
          repos: app.threadRepos,
          projects: app.projectRepo,
          workContextNotices: app.workContextNotices,
          workAuthorityResolver: app.workAuthorityResolver,
          works: app.workRepo,
          stopThreads: app.stopThreads,
        },
        thread.id,
        user.userId,
        "deleted",
      );
      return { status: "done" };
    },
    () => undefined,
  );
  app.projectWakeHub.publish({
    type: "project-chats-hint",
    projectId: thread.projectId,
    removedChatIds: [thread.id],
  });
  setResponseStatus(event, 204);
});
