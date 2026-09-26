/**
 * Internal primary-thread derivation for handoff and fork agent swaps. A
 * derivation is a SIBLING of its source, never the source's child: it takes
 * the source's `parentThreadId`, `rootThreadId`, and `spawnDepth` as its own,
 * so it shares the source's lineage instead of extending it. The fork-source
 * relationship itself is carried by `originTurnId` (the anchor turn lives on
 * the source thread), never by `parentThreadId`.
 */
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Thread, ThreadOriginType } from "@meridian/contracts/threads";
import { toIsoString } from "./contract-serialization.js";

export interface CreateDerivedPrimaryThreadInput {
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId: WorkId | null;
  /** The source thread's own lineage, inherited byte-for-byte (see file header). */
  source: Pick<Thread, "parentThreadId" | "rootThreadId" | "spawnDepth">;
  originType: Extract<ThreadOriginType, "handoff" | "fork">;
  originTurnId?: TurnId | null;
  title?: string | null;
  inheritedPrompt?: Pick<Thread, "composedSystemPrompt" | "bakedSkillSlugs" | "bakedTools">;
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
    bakedTools: input.inheritedPrompt?.bakedTools ?? null,
    agentDefinitionRevisionId: null,
    agentName: null,
    nextSeq: "0",
    activeLeafTurnId: null,
    parentThreadId: input.source.parentThreadId,
    originType: input.originType,
    originTurnId: input.originTurnId ?? null,
    rootThreadId: input.source.rootThreadId,
    spawnDepth: input.source.spawnDepth,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    historySummary: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
