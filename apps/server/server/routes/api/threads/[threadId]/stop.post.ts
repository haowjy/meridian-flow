/**
 * POST /api/threads/:threadId/stop: chat Stop, decided once on the server from rows. Cancels the
 * running reply the writer saw (or that took on a message they saw) and hands back every waiting
 * writer message no execution has taken on, answering their content for the acting tab's composer.
 * A replay of the same request id answers the stored decision (200); the same id with another body
 * is a 409.
 */
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
    const openAsk = await app.threadRepos.asks.findOpenByThread(threadId);
    if (openAsk) await app.asks.cancelOpen(threadId, openAsk.id);
    return serializeTransport((await app.runner.stop(threadId, request)) satisfies StopResponse);
  } catch (error) {
    if (error instanceof HandBackConflictError)
      throw createError({ statusCode: 409, message: error.code });
    throw error;
  }
});
