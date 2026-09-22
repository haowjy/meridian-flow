/** PATCH /api/threads/:threadId/title: persists a writer-authored thread title. */
import { renameThreadRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread title" });
  }
  const parsed = renameThreadRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread title" });
  }
  const thread = await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  const updated = await app.repos.threads.updateTitle(thread.id, parsed.data.title);
  return serializeTransport({
    threadId: updated.id,
    title: updated.title ?? parsed.data.title,
    updatedAt: updated.updatedAt,
  });
});
