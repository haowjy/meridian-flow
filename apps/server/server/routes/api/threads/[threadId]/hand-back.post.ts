import { handBackRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import type { HandBackRequest, HandBackResponse } from "@meridian/contracts/threads";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { HandBackConflictError } from "../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = handBackRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_hand_back" });
  try {
    const request: HandBackRequest = parsed.data;
    return serializeTransport(
      (await app.runner.handBack(threadId, request)) satisfies HandBackResponse,
    );
  } catch (error) {
    if (error instanceof HandBackConflictError)
      throw createError({ statusCode: 409, message: error.code });
    throw error;
  }
});
