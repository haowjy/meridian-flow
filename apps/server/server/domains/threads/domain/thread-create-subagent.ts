/**
 * Internal subagent thread creation — the only path that may set spawn tree
 * fields. Public HTTP create uses normalizeThreadCreate, which rejects them.
 */
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { SpawnStatus, Thread } from "@meridian/contracts/threads";
import { toIsoString } from "./contract-serialization.js";

export interface CreateSubagentThreadInput {
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId?: WorkId | null;
  parentThreadId: ThreadId;
  rootThreadId: ThreadId;
  originTurnId?: TurnId;
  spawnDepth: number;
  currentAgent: string;
  composedSystemPrompt: string;
  /** Model-invocable slugs frozen with composedSystemPrompt; empty when none. */
  bakedSkillSlugs: string[];
  title?: string | null;
  spawnStatus?: SpawnStatus;
}

/** Build a subagent Thread row — not reachable from public create normalization. */
export function buildSubagentThreadRow(input: CreateSubagentThreadInput): Thread {
  const now = toIsoString(new Date());
  const id = input.id ?? crypto.randomUUID();
  return {
    id,
    projectId: input.projectId,
    workId: input.workId ?? null,
    userId: input.userId,
    kind: "subagent",
    status: "idle",
    title: input.title ?? null,
    composedSystemPrompt: input.composedSystemPrompt,
    bakedSkillSlugs: input.bakedSkillSlugs,
    // Frozen subagents bake into composedSystemPrompt; systemPrompt stays null
    // (agent-bound resolution uses currentAgent, same as drizzle mapThread).
    systemPrompt: null,
    workingState: null,
    currentAgent: input.currentAgent,
    nextSeq: "0",
    parentThreadId: input.parentThreadId,
    rootThreadId: input.rootThreadId,
    spawnDepth: input.spawnDepth,
    spawnStatus: input.spawnStatus ?? "running",
    spawnResult: null,
    totalCostUsd: "0",
    turnCount: 0,
    historySummary: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
