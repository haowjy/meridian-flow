import type { CommandId, ProjectId } from "@meridian/contracts";
import {
  serializeTransport,
  updateThreadUserStateRequestSchema,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread user state" });
  }
  const { commandId, body } = splitCommandBody(await readBody(event));
  const parsed = updateThreadUserStateRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread user state" });
  }
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
    { includeDeleted: true },
  );
  const result = await runRouteCommand<{ status: "done"; threadId: string; isFavorite: boolean }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId: thread.projectId as ProjectId,
      kind: "chat_favorite",
      selectors: { threadId: thread.id },
      body: parsed.data,
    },
    async () => ({
      status: "done",
      ...(await app.threadRepos.threadUserState.update({
        threadId: thread.id,
        userId: user.userId,
        ...parsed.data,
      })),
    }),
    () => undefined,
  );
  return serializeTransport({ threadId: result.threadId, isFavorite: result.isFavorite });
});
