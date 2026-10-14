/** Build a navigate-first destination before the server creates it. */
import type { Thread } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { CreationAgent } from "@/features/agents/creation-agent";

const OPTIMISTIC_OWNER_ID = "optimistic-local";
export function makeOptimisticThread(input: {
  id: string;
  projectId: string;
  title: string;
  timestamp: string;
  workId?: string | null;
  aiWriteMode: AiWriteMode;
  agent?: CreationAgent;
}): Thread {
  return {
    id: input.id,
    projectId: input.projectId,
    workId: input.workId ?? null,
    aiWriteMode: input.aiWriteMode,
    effectiveAiWriteMode: input.aiWriteMode,
    userId: OPTIMISTIC_OWNER_ID,
    kind: "primary",
    status: "idle",
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
