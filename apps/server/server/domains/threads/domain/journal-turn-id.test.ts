/**
 * Journal turn-id derivation tests: covers every known orchestrator event
 * carrier so adapter metadata stays consistent as event shapes evolve.
 */
import { describe, expect, it } from "vitest";
import type { JournalEventEnvelope } from "../ports/event-journal.js";
import { deriveJournalTurnId } from "./journal-turn-id.js";

describe("deriveJournalTurnId", () => {
  it("reads turn ids from every journal event carrier", () => {
    const turnEvent = {
      type: "turn.created",
      turn: {
        id: "turn_1",
        threadId: "thread_1",
        role: "assistant",
        status: "streaming",
        finishReason: null,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalCostUsd: "0",
        totalMillicredits: "0",
        responseCount: 0,
        usage: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        blocks: [],
        siblingIds: [],
        responses: [],
      },
    } satisfies JournalEventEnvelope;

    const responseEvent = {
      type: "model.response_received",
      response: {
        id: "response_1",
        turnId: "turn_response",
        sequence: 1,
        provider: "openai",
        model: "gpt-test",
      },
    } satisfies JournalEventEnvelope;

    const blockEvent = {
      type: "block.upserted",
      block: {
        id: "block_1",
        turnId: "turn_block",
        responseId: null,
        blockType: "text",
        sequence: 1,
        content: "hello",
        provider: null,
        status: "complete",
      },
    } satisfies JournalEventEnvelope;

    const usageEvent = {
      type: "usage",
      responseId: "response_1",
      turnId: "turn_usage",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: "0.01",
      turnCostUsd: "0.01",
    } satisfies JournalEventEnvelope;

    const noTurnEvent = {
      type: "block.pruned",
      blockId: "block_1",
    } satisfies JournalEventEnvelope;

    expect(deriveJournalTurnId(turnEvent)).toBe("turn_1");
    expect(deriveJournalTurnId(responseEvent)).toBe("turn_response");
    expect(deriveJournalTurnId(blockEvent)).toBe("turn_block");
    expect(deriveJournalTurnId(usageEvent)).toBe("turn_usage");
    expect(deriveJournalTurnId(noTurnEvent)).toBeNull();
  });
});
