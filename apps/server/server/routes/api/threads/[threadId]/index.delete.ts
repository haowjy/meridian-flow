/** DELETE /api/threads/[threadId]: soft-deletes an owned thread (idempotent). Depends on the auth gate, thread ownership, and thread repositories. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { deleteOwnedThreadToTrash } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, workContextDelivery } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  await deleteOwnedThreadToTrash(
    {
      repos,
      projects: projectRepo,
      obligations: repos.workContextDeliveries,
      workContextDelivery,
      workAuthorityResolver: app.workAuthorityResolver,
    },
    threadId,
    userId,
  );
  setResponseStatus(event, 204);
});
