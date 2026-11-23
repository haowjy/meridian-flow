/** PUT /api/threads/:threadId/draft: the chat's lineage writes into another of its Work's drafts. */
import type { CommandId, ProjectId, ThreadId } from "@meridian/contracts";
import type { SetChatDraftResult } from "@meridian/contracts/drafts";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";
import { draftIdParam } from "../../../../lib/work-drafts-route.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  if (!isUuid(threadId)) throw createError({ statusCode: 400, message: "Invalid thread" });
  const { commandId, body } = splitCommandBody(await readBody(event));
  const draftId = draftIdParam(typeof body.draftId === "string" ? body.draftId : undefined);
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
  );
  return runRouteCommand<SetChatDraftResult>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId: thread.projectId as ProjectId,
      kind: "chat_draft",
      selectors: { threadId: thread.id },
      body,
    },
    async () => {
      await app.documentSync.workDrafts.setChatDraft({ threadId: thread.id as ThreadId, draftId });
      const after = await app.threadRepos.threads.findById(thread.id);
      return {
        status: "done",
        threadId: thread.id as ThreadId,
        draftId: (after?.draftId ?? thread.draftId) as SetChatDraftResult["draftId"],
      };
    },
    () => undefined,
  );
});
