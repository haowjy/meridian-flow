/** DELETE /api/threads/[threadId]: soft-deletes an owned thread (idempotent). Depends on the auth gate, thread ownership, and thread repositories. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, workbenchRepo } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  await requireThreadOwner(
    { threads: repos.threads, workbenches: workbenchRepo },
    threadId,
    userId,
  );
  await repos.threads.softDelete(threadId);
  setResponseStatus(event, 204);
});
