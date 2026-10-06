/** Route core for authenticated Work AI write mode updates. */
import { meridianErrorFromSystem, type PendingChangesChoice } from "@meridian/contracts/protocol";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { AiWriteMode } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { SetWorkPushPolicyInput, SetWorkPushPolicyResult } from "../domains/collab/index.js";
import {
  type WorkContextNotices,
  WorkLifecycleUnavailableError,
} from "../domains/projects/index.js";
import type { AppServices } from "./app.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";

type WorkWriteModeServices = {
  works: {
    findById(workId: WorkId): Promise<{
      id: WorkId;
      createdByUserId: UserId;
      aiWriteMode: AiWriteMode;
    } | null>;
  };
  branchPush: {
    setWorkPushPolicy(input: SetWorkPushPolicyInput): Promise<SetWorkPushPolicyResult>;
  };
  workContextNotices: Pick<WorkContextNotices, "workChanged">;
};

export function selectWorkWriteModeServices(app: AppServices): WorkWriteModeServices {
  return {
    works: app.workRepo,
    branchPush: app.documentSync,
    workContextNotices: app.workContextNotices,
  };
}

/**
 * Switching to auto-apply with pending changes needs `pending` (D40): without
 * it the route answers `confirmation_required` so the client can ask. An
 * archived Work refuses `apply` under its lock (D30).
 */
export async function handleWorkWriteModeRequest(
  deps: WorkWriteModeServices,
  input: {
    projectId: string;
    workId: WorkId;
    userId: UserId;
    aiWriteMode: unknown;
    pending?: unknown;
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
  const pending = parsePending(input.pending);
  if (pending === null) {
    throw createError({ statusCode: 400, message: "pending must be 'apply' or 'keep'" });
  }

  const work = await deps.works.findById(input.workId);
  if (!work || work.createdByUserId !== input.userId) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }

  const policyResult = await deps.branchPush
    .setWorkPushPolicy({
      workId: input.workId,
      policy: aiWriteMode === "direct" ? "auto" : "manual",
      ...(pending ? { pending } : {}),
      pushedByUserId: input.userId,
    })
    .catch((cause: unknown) => {
      // An archived Work's drafts are frozen: Apply's push refuses under the Work lock.
      if (cause instanceof WorkLifecycleUnavailableError && cause.state === "archived") {
        throwArchivedApply();
      }
      throw cause;
    });
  if (policyResult.status === "confirmation_required") {
    return {
      aiWriteMode: work.aiWriteMode,
      status: "confirmation_required",
      reason: "pending_branch_changes",
      pendingChangeCount: policyResult.unpushedCount,
      message: policyResult.reason,
    };
  }

  // The Work's chats are told where their writes now land (work context).
  if (aiWriteMode !== work.aiWriteMode) await deps.workContextNotices.workChanged(input.workId);
  return { aiWriteMode, status: "updated" };
}

function throwArchivedApply(): never {
  throwHttpInterrupt(
    meridianErrorFromSystem(
      "work_archived",
      "This Work is archived, so its pending changes are frozen. Keep them for review, or unarchive the Work to apply them.",
    ),
    409,
  );
}

function parseAiWriteMode(value: unknown): AiWriteMode | null {
  return value === "direct" || value === "draft" ? value : null;
}

/** `undefined` when absent, `null` when present but invalid. */
function parsePending(value: unknown): PendingChangesChoice | undefined | null {
  if (value === undefined || value === null) return undefined;
  return value === "apply" || value === "keep" ? value : null;
}
