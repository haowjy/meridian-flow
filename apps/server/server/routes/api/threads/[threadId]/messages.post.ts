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

  const response = await app.threadRuntime.sendMessage({
    threadId,
    userId: user.userId,
    text: body.text,
  });
  setResponseStatus(event, 202);
  return response;
});
