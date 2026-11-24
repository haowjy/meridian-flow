import type { Thread } from "@meridian/contracts/protocol";
import { NO_OVERRIDES, type ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { CreationAgent } from "@/features/agents/creation-agent";

const OPTIMISTIC_OWNER_ID = "optimistic-local";
export function makeOptimisticThread(input: {
  id: string;
  draftId: string;
  projectId: string;
  title: string;
  timestamp: string;
  workId?: string | null;
  aiWriteMode: AiWriteMode;
  agent?: CreationAgent;
  overrides?: ThreadOverrides;
}): Thread {
  return {
    id: input.id,
    draftId: input.draftId,
    projectId: input.projectId,
    workId: input.workId ?? null,
    aiWriteMode: input.aiWriteMode,
    effectiveAiWriteMode: input.aiWriteMode,
    overrides: input.overrides ?? NO_OVERRIDES,
    userId: OPTIMISTIC_OWNER_ID,
    kind: "primary",
    title: input.title,
    ref: null,
    initialPromptBakeId: null,
    agentDefinitionRevisionId: input.agent?.selection.definitionRevisionId ?? null,
    agentName: input.agent?.name ?? null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: input.id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    lastActivityAt: input.timestamp,
    deletedAt: null,
  };
}
