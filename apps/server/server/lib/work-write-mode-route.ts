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
  branchPush: {
    setWorkPushPolicy(input: {
      workId: WorkId;
      policy: "manual" | "auto";
      confirmedPush?: boolean;
      pushedByUserId?: UserId;
    }): Promise<unknown>;
  };
};

export function selectWorkWriteModeServices(app: AppServices): WorkWriteModeServices {
  return {
    works: app.workRepo,
    branchPush: app.documentSync,
  };
}

export async function handleWorkWriteModeRequest(
  deps: WorkWriteModeServices,
  input: {
    projectId: string;
    workId: WorkId;
    userId: UserId;
    aiWriteMode: unknown;
    confirmedPush?: boolean;
  },
): Promise<
  | { aiWriteMode: AiWriteMode; status: "updated" }
  | {
      aiWriteMode: AiWriteMode;
      status: "confirmation_required";
      reason: "pending_branch_changes";
      pendingChangeCount: number;
      message: string;
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

  const pushPolicy = aiWriteMode === "direct" ? "auto" : "manual";
  const policyResult = await deps.branchPush.setWorkPushPolicy({
    workId: input.workId,
    policy: pushPolicy,
    confirmedPush: input.confirmedPush,
    pushedByUserId: input.userId,
  });
  if (isConfirmationRequired(policyResult)) {
    return {
      aiWriteMode: work.aiWriteMode,
      status: "confirmation_required",
      reason: "pending_branch_changes",
      pendingChangeCount: policyResult.unpushedCount,
      message: policyResult.reason,
    };
  }

  await deps.works.updateWriteMode(input.workId, aiWriteMode);
  return { aiWriteMode, status: "updated" };
}

function parseAiWriteMode(value: unknown): AiWriteMode | null {
  return value === "direct" || value === "draft" ? value : null;
}

function isConfirmationRequired(
  value: unknown,
): value is { status: "confirmation_required"; unpushedCount: number; reason: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "confirmation_required" &&
    "unpushedCount" in value &&
    typeof value.unpushedCount === "number" &&
    "reason" in value &&
    typeof value.reason === "string"
  );
}
