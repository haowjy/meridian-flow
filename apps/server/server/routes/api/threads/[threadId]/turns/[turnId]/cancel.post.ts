/** POST /api/threads/[threadId]/turns/[turnId]/cancel: cancels an in-flight turn on an owned thread. Depends on the auth gate, thread ownership, and the turn runner. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, runner } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";
  const turnId = requireRequestId(getRouterParam(event, "turnId"), "turnId");

  await requireThreadOwner({ threads: repos.threads, projects: projectRepo }, threadId, userId);
  const status = await runner.cancel(threadId, turnId);

  return { threadId, turnId, status };
});
