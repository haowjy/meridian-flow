import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { deleteOwnedThreadToTrash } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos, projectRepo, workContextNotices } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  const thread = await deleteOwnedThreadToTrash(
    {
      repos: threadRepos,
      projects: projectRepo,
      workContextNotices,
      workAuthorityResolver: app.workAuthorityResolver,
      works: app.workRepo,
      stopThreads: app.stopThreads,
    },
    threadId,
    userId,
  );
  app.projectWakeHub.publish({
    type: "project-chats-hint",
    projectId: thread.projectId,
    removedChatIds: [thread.id],
  });
  setResponseStatus(event, 204);
});
