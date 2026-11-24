import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import { NO_OVERRIDES, type SpawnStatus, type Thread } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { toIsoString } from "./contract-serialization.js";

export interface CreateSubagentThreadInput {
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId?: WorkId | null;
  aiWriteMode: AiWriteMode;
  parentThreadId: ThreadId;
  rootThreadId: ThreadId;
  originTurnId: TurnId;
  spawnDepth: number;
  title?: string | null;
  spawnStatus?: SpawnStatus;
}

export function buildSubagentThreadRow(input: CreateSubagentThreadInput): Omit<Thread, "draftId"> {
  const now = toIsoString(new Date());
  const id = input.id ?? crypto.randomUUID();
  return {
    id,
    projectId: input.projectId,
    workId: input.workId ?? null,
    aiWriteMode: input.aiWriteMode,
    effectiveAiWriteMode: input.aiWriteMode,
    userId: input.userId,
    kind: "subagent",
    title: input.title ?? null,
    ref: null,
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: null,
    overrides: NO_OVERRIDES,
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
