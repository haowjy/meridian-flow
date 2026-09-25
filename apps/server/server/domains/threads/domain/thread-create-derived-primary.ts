/** Internal primary-thread derivation for handoff and fork agent swaps. */
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread, ThreadOriginType } from "@meridian/contracts/threads";
import { toIsoString } from "./contract-serialization.js";

export interface CreateDerivedPrimaryThreadInput {
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId: WorkId | null;
  parentThreadId: ThreadId;
  originType: Extract<ThreadOriginType, "handoff" | "fork">;
  originTurnId?: TurnId | null;
  title?: string | null;
  inheritedPrompt?: Pick<Thread, "composedSystemPrompt" | "bakedSkillSlugs">;
}

export function buildDerivedPrimaryThreadRow(input: CreateDerivedPrimaryThreadInput): Thread {
  const now = toIsoString(new Date());
  const id = input.id ?? crypto.randomUUID();
  return {
    id,
    projectId: input.projectId,
    workId: input.workId,
    userId: input.userId,
    kind: "primary",
    status: "idle",
    title: input.title ?? null,
    ref: null,
    composedSystemPrompt: input.inheritedPrompt?.composedSystemPrompt ?? null,
    bakedSkillSlugs: input.inheritedPrompt?.bakedSkillSlugs ?? null,
    workingState: null,
    agentDefinitionRevisionId: null,
    agentName: null,
    nextSeq: "0",
    activeLeafTurnId: null,
    parentThreadId: input.parentThreadId,
    originType: input.originType,
    originTurnId: input.originTurnId ?? null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    historySummary: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
