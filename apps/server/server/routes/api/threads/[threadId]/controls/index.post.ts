/** Enqueues a writer control; execution policy is evaluated at its boundary. */
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import {
  requireCompletedReplyForCompaction,
  ThreadControlError,
  threadControlRequestSchema,
} from "../../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = threadControlRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_control" });
  const turns = await app.repos.turns.listByThread(threadId);
  try {
    requireCompletedReplyForCompaction(turns);
    const result = await app.delivery.enqueueControl({
      ...parsed.data,
      threadId,
      actorId: user.userId,
    });
    setResponseStatus(event, result.created ? 201 : 200);
    return result.response;
  } catch (error) {
    if (error instanceof ThreadControlError)
      throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
