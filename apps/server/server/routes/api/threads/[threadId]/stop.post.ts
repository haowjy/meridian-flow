import { serializeTransport, stopRequestSchema } from "@meridian/contracts/protocol";
import type { StopRequest, StopResponse } from "@meridian/contracts/threads";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { HandBackConflictError } from "../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = stopRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_stop" });
  try {
    const request: StopRequest = parsed.data;
    return serializeTransport((await app.runner.stop(threadId, request)) satisfies StopResponse);
  } catch (error) {
    if (error instanceof HandBackConflictError)
      throw createError({ statusCode: 409, message: error.code });
    throw error;
  }
});
