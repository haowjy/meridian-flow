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
    listActiveDraftsByWork(input: { workId: WorkId }): Promise<ReadonlyArray<unknown>>;
    countInFlightDraftSessionsByWork?(input: { workId: WorkId }): number;
  };
};

export function selectWorkWriteModeServices(app: AppServices): WorkWriteModeServices {
  return {
    works: app.workRepo,
    drafts: app.documentSync.draftSessionStats,
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
    const activeDraftCount =
      (await deps.drafts.listActiveDraftsByWork({ workId: input.workId })).length +
      (deps.drafts.countInFlightDraftSessionsByWork?.({ workId: input.workId }) ?? 0);
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
