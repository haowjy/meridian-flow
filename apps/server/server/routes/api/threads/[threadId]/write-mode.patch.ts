/** PATCH /api/threads/:threadId/write-mode: updates a thread's AI write mode, guarded by active draft state. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { AiWriteMode } from "@meridian/contracts/threads";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";

function parseAiWriteMode(value: unknown): AiWriteMode | null {
  return value === "direct" || value === "draft" ? value : null;
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const body = (await readBody<{ aiWriteMode?: unknown }>(event)) ?? {};
  const aiWriteMode = parseAiWriteMode(body.aiWriteMode);

  if (!aiWriteMode) {
    throw createError({ statusCode: 400, message: "aiWriteMode must be 'direct' or 'draft'" });
  }

  const thread = await app.threadRepos.threads.findById(threadId);
  if (!thread || thread.userId !== user.userId) {
    throw createError({ statusCode: 404, message: "Thread not found" });
  }

  if (aiWriteMode === "direct") {
    const activeDrafts = await app.documentSync.drafts.listActiveDrafts({ threadId });
    if (activeDrafts.length > 0) {
      throw createError({
        statusCode: 409,
        message:
          "Cannot switch to direct mode while active drafts exist. Accept or discard all drafts first.",
      });
    }
  }

  await app.threadRepos.threads.updateWriteMode(threadId, aiWriteMode);
  return { aiWriteMode };
});
