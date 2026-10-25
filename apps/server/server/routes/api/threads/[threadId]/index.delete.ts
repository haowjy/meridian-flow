/** DELETE /api/threads/[threadId]: soft-deletes an owned thread (idempotent). Depends on the auth gate, thread ownership, and thread repositories. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { deleteOwnedThreadToTrash, requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos, projectRepo, workContextNotices } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  const owned = await requireThreadOwner({ threads: threadRepos.threads }, threadId, userId);
  const openAsk = await threadRepos.asks.findOpenByThread(owned.id);
  if (openAsk) await app.asks.cancelOpen(openAsk.threadId, openAsk.id);

  await deleteOwnedThreadToTrash(
    {
      repos: threadRepos,
      projects: projectRepo,
      workContextNotices,
      workAuthorityResolver: app.workAuthorityResolver,
      works: app.workRepo,
    },
    threadId,
    userId,
  );
  setResponseStatus(event, 204);
});
