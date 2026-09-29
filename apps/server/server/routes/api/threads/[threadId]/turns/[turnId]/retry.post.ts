/** POST /api/threads/:threadId/turns/:turnId/retry: retry a latest failed reply. */
import { replyRetryRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import {
  ReplyRetryUnavailableError,
  RuntimeShuttingDownError,
} from "../../../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const turnId = requireRequestId(getRouterParam(event, "turnId"), "turnId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = replyRetryRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_reply_retry" });
  try {
    const result = await app.runner.retryReply({
      threadId,
      failedTurnId: turnId,
      replyTurnId: parsed.data.id,
    });
    setResponseStatus(event, result.created ? 201 : 200);
    return serializeTransport(result.turn);
  } catch (error) {
    if (error instanceof ReplyRetryUnavailableError)
      throw createError({ statusCode: 409, message: error.code });
    if (error instanceof RuntimeShuttingDownError)
      throw createError({ statusCode: 503, message: error.message });
    throw error;
  }
});
