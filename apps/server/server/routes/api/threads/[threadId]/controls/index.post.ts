/** Enqueues a writer control; execution policy is evaluated at its boundary. */
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { z } from "zod";
import { ThreadControlError } from "../../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

const request = z
  .object({
    id: z.string().uuid(),
    control: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("compact") }).strict(),
      z
        .object({ kind: z.literal("compaction_undo"), compactionTurnId: z.string().uuid() })
        .strict(),
    ]),
  })
  .strict();
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  const parsed = request.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "invalid_control" });
  try {
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
