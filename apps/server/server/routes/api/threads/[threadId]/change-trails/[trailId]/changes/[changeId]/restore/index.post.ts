/** Restores captured writer prose as a fresh human-origin forward mutation. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const trailId = requireRequestId(getRouterParam(event, "trailId"), "trailId");
  const changeId = getRouterParam(event, "changeId") ?? "";
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  return app.documentSync.restoreTrailChange({
    threadId: thread.id as ThreadId,
    trailId,
    changeId,
    userId: user.userId,
  });
});
