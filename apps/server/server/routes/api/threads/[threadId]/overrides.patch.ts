/** PATCH /api/threads/:threadId/overrides: sets or clears the chat's model and reasoning overrides, as a command. */
import type { CommandId, ProjectId } from "@meridian/contracts";
import { serializeTransport, setThreadOverridesRequestSchema } from "@meridian/contracts/protocol";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread overrides" });
  }
  const parsed = setThreadOverridesRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid thread overrides" });
  }
  const { commandId, body } = splitCommandBody(parsed.data);
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
  );
  // Stored as asked, never refused: a model the gateway doesn't list, or a reasoning setting the
  // model doesn't accept, falls back at turn time.
  const result = await runRouteCommand<{
    status: "done";
    threadId: string;
    overrides: ThreadOverrides;
  }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId: thread.projectId as ProjectId,
      kind: "thread_set_overrides",
      selectors: { threadId: thread.id },
      body,
    },
    async () => {
      const updated = await app.threadRepos.threads.setOverrides(thread.id, parsed.data.overrides);
      return { status: "done", threadId: updated.id, overrides: updated.overrides };
    },
    () => undefined,
  );
  return serializeTransport({ threadId: result.threadId, overrides: result.overrides });
});
