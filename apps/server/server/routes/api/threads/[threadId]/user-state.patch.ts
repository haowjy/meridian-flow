/** PATCH favorite state or acknowledge a visible open for the authenticated writer. */
import {
  serializeTransport,
  updateThreadUserStateRequestSchema,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread user state" });
  }
  const parsed = updateThreadUserStateRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread user state" });
  }
  const thread = await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  return serializeTransport(
    await app.repos.threadUserState.update({
      threadId: thread.id,
      userId: user.userId,
      ...parsed.data,
    }),
  );
});
