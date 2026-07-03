/** Route core for authenticated Work AI write mode updates. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { AiWriteMode } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { AppServices } from "./app.js";

type WorkWriteModeServices = {
  works: {
    findById(
      workId: WorkId,
    ): Promise<{ id: WorkId; createdByUserId: UserId; aiWriteMode: AiWriteMode } | null>;
    updateWriteMode(workId: WorkId, aiWriteMode: AiWriteMode): Promise<void>;
  };
  drafts: {
    listActiveDrafts(input: { threadId: string }): Promise<ReadonlyArray<unknown>>;
  };
  threads: {
    listByWork(projectId: string, workId: WorkId): Promise<ReadonlyArray<{ id: string }>>;
  };
};

export function selectWorkWriteModeServices(app: AppServices): WorkWriteModeServices {
  return {
    works: app.workRepo,
    drafts: app.documentSync.drafts,
    threads: app.threadRepos.threads,
  };
}

export async function handleWorkWriteModeRequest(
  deps: WorkWriteModeServices,
  input: { projectId: string; workId: WorkId; userId: UserId; aiWriteMode: unknown },
): Promise<
  | { aiWriteMode: AiWriteMode; status: "updated" }
  | {
      aiWriteMode: AiWriteMode;
      status: "rejected";
      reason: "active_drafts";
      activeDraftCount: number;
    }
> {
  const aiWriteMode = parseAiWriteMode(input.aiWriteMode);
  if (!aiWriteMode) {
    throw createError({ statusCode: 400, message: "aiWriteMode must be 'direct' or 'draft'" });
  }

  const work = await deps.works.findById(input.workId);
  if (!work || work.createdByUserId !== input.userId) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }

  if (aiWriteMode === "direct") {
    const threads = await deps.threads.listByWork(input.projectId, input.workId);
    const activeDraftCount = threads[0]
      ? (await deps.drafts.listActiveDrafts({ threadId: threads[0].id })).length
      : 0;
    if (activeDraftCount > 0) {
      return {
        aiWriteMode: work.aiWriteMode,
        status: "rejected",
        reason: "active_drafts",
        activeDraftCount,
      };
    }
  }

  await deps.works.updateWriteMode(input.workId, aiWriteMode);
  return { aiWriteMode, status: "updated" };
}

function parseAiWriteMode(value: unknown): AiWriteMode | null {
  return value === "direct" || value === "draft" ? value : null;
}
