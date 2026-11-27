import type { CommandId, ProjectId } from "@meridian/contracts";
import { renameThreadRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread title" });
  }
  const { commandId, body } = splitCommandBody(await readBody(event));
  const parsed = renameThreadRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread title" });
  }
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
    { includeDeleted: true },
  );
  const result = await runRouteCommand<{
    status: "done";
    threadId: string;
    title: string;
    updatedAt: string;
  }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId: thread.projectId as ProjectId,
      kind: "chat_rename",
      selectors: { threadId: thread.id },
      body: parsed.data,
    },
    async () => {
      const updated = await app.threadRepos.threads.updateTitle(thread.id, parsed.data.title);
      return {
        status: "done",
        threadId: updated.id,
        title: updated.title ?? parsed.data.title,
        updatedAt: updated.updatedAt,
      };
    },
    () => undefined,
  );
  const { status: _status, ...renamed } = result;
  return serializeTransport(renamed);
});
