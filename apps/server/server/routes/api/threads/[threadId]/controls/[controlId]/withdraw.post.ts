/** Withdrawal and reservation serialize at the domain's thread boundary. */
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { ThreadControlError } from "../../../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const controlId = requireRequestId(getRouterParam(event, "controlId"), "controlId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  try {
    return await app.delivery.withdrawControl(threadId, controlId);
  } catch (error) {
    if (error instanceof ThreadControlError)
      throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
