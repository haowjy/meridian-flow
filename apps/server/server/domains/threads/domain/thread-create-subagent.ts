/**
 * Internal subagent thread creation — the only path that may set spawn tree
 * fields. Public HTTP create uses normalizeThreadCreate, which rejects them.
 */
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { SpawnStatus, Thread } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { toIsoString } from "./contract-serialization.js";

export interface CreateSubagentThreadInput {
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId?: WorkId | null;
  /** The parent chat's mode, which is also the spawning reply's. */
  aiWriteMode: AiWriteMode;
  parentThreadId: ThreadId;
  rootThreadId: ThreadId;
  originTurnId: TurnId;
  spawnDepth: number;
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
    aiWriteMode: input.aiWriteMode,
    userId: input.userId,
    kind: "subagent",
    status: "idle",
    title: input.title ?? null,
    ref: null,
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: null,
    nextSeq: "0",
    activeLeafTurnId: null,
    parentThreadId: input.parentThreadId,
    rootThreadId: input.rootThreadId,
    originTurnId: input.originTurnId,
    spawnDepth: input.spawnDepth,
    spawnStatus: input.spawnStatus ?? "running",
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    deletedAt: null,
  };
}
