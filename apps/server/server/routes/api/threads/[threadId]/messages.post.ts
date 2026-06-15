import type { SendMessageRequest, SendMessageResponse } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event): Promise<SendMessageResponse> => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const body = (await readBody<SendMessageRequest>(event)) ?? { text: "" };
  if (typeof body.text !== "string" || body.text.length === 0) {
    throw createError({ statusCode: 400, message: "text is required" });
  }

  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const result = await app.runner.startTurn({
    threadId,
    userText: body.text,
    connectionToken: body.connectionToken,
  });
  setResponseStatus(event, 202);
  return {
    threadId,
    userTurnId: result.userTurnId,
    assistantTurnId: result.assistantTurnId,
    streamCursor: result.streamCursor,
    status: "accepted",
  };
});
