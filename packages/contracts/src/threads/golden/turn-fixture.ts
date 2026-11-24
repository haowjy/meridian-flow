import type { Turn } from "../index.js";

export const GOLDEN_EXECUTION_ID = "execution_golden";

export function goldenAssistantTurn(
  id: string,
  threadId: string,
  status: Turn["status"] = "streaming",
  reservedForUserTurnIds: string[] = [],
): Turn {
  return {
    id,
    threadId,
    position: 1,
    parentTurnId: null,
    role: "assistant",
    origin: "assistant",
    writeMode: null,
    status,
    executionId: GOLDEN_EXECUTION_ID,
    reservedForUserTurnIds,
    delivery: null,
    forgottenBy: null,
    promptBakeId: null,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0.000000",
    totalMillicredits: "0",
    responseCount: 0,
    usage: null,
    error: null,
    requestParams: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: status === "complete" ? "2026-01-01T00:00:01.000Z" : null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}
