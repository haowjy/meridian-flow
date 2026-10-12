/** Build a navigate-first destination before the server creates it. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/protocol";

const OPTIMISTIC_OWNER_ID = "optimistic-local";
export function makeOptimisticThread(input: {
  id: string;
  projectId: string;
  title: string;
  timestamp: string;
  workId?: string | null;
  agent?: Pick<AgentCatalogItem, "selection" | "slug" | "name">;
}): Thread {
  return {
    id: input.id,
    projectId: input.projectId,
    workId: input.workId ?? null,
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
