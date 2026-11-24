import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const turnId = requireRequestId(getRouterParam(event, "turnId"), "turnId");

  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
  );
  const status = await app.runner.cancel(thread.id, turnId);
  return { threadId: thread.id, turnId, status };
});
