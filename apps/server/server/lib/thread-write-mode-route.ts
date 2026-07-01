/** Route core for authenticated thread AI write mode updates. */
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import type { AiWriteMode } from "@meridian/contracts/threads";
import { createError } from "nitro/h3";
import type { AppServices } from "./app.js";

type ThreadWriteModeServices = {
  threads: {
    findById(threadId: ThreadId): Promise<{ userId: UserId } | null>;
    updateWriteMode(threadId: ThreadId, aiWriteMode: AiWriteMode): Promise<void>;
  };
  drafts: {
    listActiveDrafts(input: { threadId: ThreadId }): Promise<ReadonlyArray<unknown>>;
  };
};

export function selectThreadWriteModeServices(app: AppServices): ThreadWriteModeServices {
  return {
    threads: app.threadRepos.threads,
    drafts: app.documentSync.drafts,
  };
}

export async function handleThreadWriteModeRequest(
  deps: ThreadWriteModeServices,
  input: { threadId: ThreadId; userId: UserId; aiWriteMode: unknown },
): Promise<{ aiWriteMode: AiWriteMode }> {
  const aiWriteMode = parseAiWriteMode(input.aiWriteMode);
  if (!aiWriteMode) {
    throw createError({ statusCode: 400, message: "aiWriteMode must be 'direct' or 'draft'" });
  }

  const thread = await deps.threads.findById(input.threadId);
  if (!thread || thread.userId !== input.userId) {
    throw createError({ statusCode: 404, message: "Thread not found" });
  }

  if (aiWriteMode === "direct") {
    const activeDrafts = await deps.drafts.listActiveDrafts({ threadId: input.threadId });
    if (activeDrafts.length > 0) {
      throw createError({
        statusCode: 409,
        message:
          "Cannot switch to direct mode while active drafts exist. Accept or discard all drafts first.",
      });
    }
  }

  await deps.threads.updateWriteMode(input.threadId, aiWriteMode);
  return { aiWriteMode };
}

function parseAiWriteMode(value: unknown): AiWriteMode | null {
  return value === "direct" || value === "draft" ? value : null;
}
