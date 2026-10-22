/**
 * POST /api/threads/:threadId/send-now: cancels the reply the writer saw so the waiting queue runs
 * next, unless that reply has already taken on a waiting message. Hands nothing back and keeps no
 * decision: `seenExecutionId` makes a repeat of the same body safe. `cancelledExecutionId: null`
 * means this attempt requested no cancellation.
 */
import { sendNowRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import type { SendNowRequest, SendNowResponse } from "@meridian/contracts/threads";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = sendNowRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_send_now" });
  const request: SendNowRequest = parsed.data;
  return serializeTransport(
    (await app.runner.sendNow(threadId, request)) satisfies SendNowResponse,
  );
});
