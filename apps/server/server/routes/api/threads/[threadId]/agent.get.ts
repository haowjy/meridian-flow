import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    getRouterParam(event, "threadId") ?? "",
    user.userId,
  );
  const agent = await app.agentCatalog.boundAgent(user.userId, thread.projectId, thread);
  if (!agent) throw createError({ statusCode: 404, message: "This chat has no Agent file" });
  return agent;
});
