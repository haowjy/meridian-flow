/** POST /api/threads/[threadId]/handoff/brief: append and launch a retry seed. */
import { handoffBriefRetryRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { HandoffRetryError } from "../../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = handoffBriefRetryRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_handoff_retry" });
  try {
    const result = await app.handoffBriefs.retry({ threadId, seedId: parsed.data.id });
    setResponseStatus(event, result.created ? 201 : 200);
    return serializeTransport(result.turn);
  } catch (error) {
    if (error instanceof HandoffRetryError)
      throw createError({ statusCode: error.statusCode, message: error.code });
    throw error;
  }
});
