/**
 * Purpose: Builds minimal JSON-natural assistant turns for golden protocol fixtures.
 * Why independent: The helper owns reusable contract-shaped fixture data shared by projection tests, not application turn creation logic.
 */
import type { Turn } from "../index.js";

/** Minimal JSON-natural assistant turn for golden orchestrator fixtures. */
export function goldenAssistantTurn(
  id: string,
  threadId: string,
  status: Turn["status"] = "streaming",
): Turn {
  return {
    id,
    threadId,
    parentTurnId: null,
    role: "assistant",
    status,
    agentDefinitionId: "agent_golden",
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
