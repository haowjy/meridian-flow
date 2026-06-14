// @ts-nocheck
/** Internal primary-thread derivation for handoff and fork agent swaps. */
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread, ThreadOriginType } from "@meridian/contracts/threads";
import { toIsoString } from "./contract-serialization.js";

export interface CreateDerivedPrimaryThreadInput {
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId: WorkId;
  parentThreadId: ThreadId;
  originType: Extract<ThreadOriginType, "handoff" | "fork">;
  originTurnId?: TurnId | null;
  currentAgent: string | null;
  title?: string | null;
  systemPrompt?: string | null;
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
    composedSystemPrompt: null,
    bakedSkillSlugs: null,
    systemPrompt: input.systemPrompt ?? null,
    workingState: null,
    currentAgent: input.currentAgent,
    nextSeq: "0",
    parentThreadId: input.parentThreadId,
    originType: input.originType,
    originTurnId: input.originTurnId ?? null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    spawnResult: null,
    totalCostUsd: "0",
    turnCount: 0,
    historySummary: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
