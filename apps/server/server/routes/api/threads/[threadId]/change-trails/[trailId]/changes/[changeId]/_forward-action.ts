/** Shared authorization and dispatch for trail forward-action routes. */
import type { TrailForwardAction } from "@meridian/contracts";
import type { ThreadId } from "@meridian/contracts/runtime";
import { getRouterParam, type H3Event } from "nitro/h3";
import { requireThreadOwner } from "../../../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../../../lib/request-id.js";

export async function applyForwardAction(event: H3Event, action: TrailForwardAction) {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const trailId = requireRequestId(getRouterParam(event, "trailId"), "trailId");
  const changeId = getRouterParam(event, "changeId") ?? "";
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  return app.documentSync.applyTrailForwardAction({
    threadId: thread.id as ThreadId,
    trailId,
    changeId,
    action,
    userId: user.userId,
  });
}
