/** PATCH /api/threads/:threadId/model: sets or clears the chat's model override, as a command. */
import type { CommandId, ProjectId } from "@meridian/contracts";
import { serializeTransport, setThreadModelRequestSchema } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread model" });
  }
  const parsed = setThreadModelRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread model" });
  }
  const { commandId, body } = splitCommandBody(parsed.data);
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
  );
  // Stored as asked, never refused: an id the gateway doesn't list falls back at turn time.
  const result = await runRouteCommand<{ status: "done"; threadId: string; model: string | null }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId: thread.projectId as ProjectId,
      kind: "thread_set_model",
      selectors: { threadId: thread.id },
      body,
    },
    async () => {
      const updated = await app.threadRepos.threads.setModelOverride(thread.id, parsed.data.model);
      return { status: "done", threadId: updated.id, model: updated.modelOverride };
    },
    () => undefined,
  );
  return serializeTransport({ threadId: result.threadId, model: result.model });
});
