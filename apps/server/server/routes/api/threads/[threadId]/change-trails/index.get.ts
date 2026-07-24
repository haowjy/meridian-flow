/** Lists authorized change-trail shells without exposing manuscript-bearing detail. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  return {
    version: 1,
    shells: await app.changeTrails.listShells(thread.id as ThreadId),
  };
});
