/** Explicit serialized start-over retirement; returns the actual durable winner. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as never;
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  return app.userTurnAdmission.retire({
    actorUserId: user.userId,
    threadId,
    submissionId: getRouterParam(event, "submissionId") ?? "",
  });
});
