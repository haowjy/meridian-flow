/** Authenticated admission reconciliation lookup; not-seen remains ambiguous. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as never;
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  return app.userTurnAdmission.lookup({
    actorUserId: user.userId,
    threadId,
    submissionId: getRouterParam(event, "submissionId") ?? "",
  });
});
