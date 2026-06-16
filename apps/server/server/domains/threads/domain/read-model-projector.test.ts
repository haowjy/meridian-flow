/**
 * Read-model projector tests: verify durable model/block events can rebuild
 * turn rows, response rows, block rows, and rollups without orchestrator direct
 * writes.
 */
import type { OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryEventJournalWriter } from "../adapters/in-memory/event-writer.js";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { projectReadModelEvent } from "./read-model-projector.js";

function turnFixture(input: Partial<Turn> & Pick<Turn, "id" | "threadId" | "role">): Turn {
  return {
    id: input.id,
    threadId: input.threadId,
    prevTurnId: input.prevTurnId ?? null,
    parentTurnId: input.parentTurnId ?? input.prevTurnId ?? null,
    role: input.role,
    status: input.status ?? "streaming",
    finishReason: input.finishReason ?? null,
    model: input.model ?? null,
    provider: input.provider ?? null,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    reasoningTokens: input.reasoningTokens ?? null,
    cacheReadTokens: input.cacheReadTokens ?? null,
    cacheWriteTokens: input.cacheWriteTokens ?? null,
    totalCostUsd: input.totalCostUsd ?? "0",
    totalMillicredits: input.totalMillicredits,
    responseCount: input.responseCount ?? 0,
    usage: input.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalCostUsd: "0",
      responseCount: 0,
    },
    error: input.error ?? null,
    requestParams: input.requestParams ?? null,
    responseMetadata: input.responseMetadata ?? null,
    createdAt: input.createdAt ?? "2026-01-02T03:04:05.000Z",
    completedAt: input.completedAt ?? null,
    blocks: input.blocks ?? [],
    siblingIds: input.siblingIds ?? [],
    responses: input.responses ?? [],
  };
}

describe("read-model projector", () => {
  it("projects model response and block events into rows and rollups", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "user-1", title: "Project" });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const turn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "streaming",
    });

    const events: OrchestratorEvent[] = [
      {
        type: "model.response_received",
        response: {
          id: "11111111-1111-4111-8111-111111111111",
          turnId: turn.id,
          sequence: 0,
          provider: "stub",
          model: "stub-model",
          inputTokens: 3,
          outputTokens: 5,
          reasoningTokens: 2,
          cacheReadTokens: 7,
          cacheWriteTokens: 11,
          costUsd: "0.001000",
          millicredits: "42",
          priceSource: "provider_reported",
          finishReason: "end_turn",
          rawUsage: { inputTokens: 3, outputTokens: 5 },
        },
      },
      {
        type: "block.upserted",
        block: {
          id: "22222222-2222-4222-8222-222222222222",
          turnId: turn.id,
          responseId: "11111111-1111-4111-8111-111111111111",
          blockType: "text",
          sequence: 0,
          content: "Projected response",
          provider: "stub",
          status: "complete",
        },
      },
      {
        type: "block.upserted",
        block: {
          id: "22222222-2222-4222-8222-333333333333",
          turnId: turn.id,
          responseId: "11111111-1111-4111-8111-111111111111",
          blockType: "reasoning",
          sequence: 1,
          content: {
            text: "Considering options",
            providerOptions: { encryptedThinking: "opaque-provider-payload" },
          },
          provider: "stub",
          status: "complete",
        },
      },
    ];

    for (const event of events) {
      await projectReadModelEvent(repos, event);
    }

    const responses = await repos.modelResponses.listByTurn(turn.id);
    expect(responses).toMatchObject([
      {
        id: "11111111-1111-4111-8111-111111111111",
        inputTokens: 3,
        outputTokens: 5,
        costUsd: "0.001000",
        millicredits: "42",
      },
    ]);

    const blocks = await repos.blocks.listByTurn(turn.id);
    expect(blocks).toMatchObject([
      {
        id: "22222222-2222-4222-8222-222222222222",
        responseId: "11111111-1111-4111-8111-111111111111",
        blockType: "text",
        textContent: "Projected response",
        modelText: "Projected response",
        content: "Projected response",
      },
      {
        id: "22222222-2222-4222-8222-333333333333",
        responseId: "11111111-1111-4111-8111-111111111111",
        blockType: "reasoning",
        textContent: "Considering options",
        modelText: "Considering options",
        content: {
          text: "Considering options",
          providerOptions: { encryptedThinking: "opaque-provider-payload" },
        },
      },
    ]);

    const projectedTurn = await repos.turns.findById(turn.id);
    expect(projectedTurn).toMatchObject({
      inputTokens: 3,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      totalCostUsd: "0.001000",
      totalMillicredits: "42",
      responseCount: 1,
      model: "stub-model",
      provider: "stub",
    });

    const projectedThread = await repos.threads.findById(thread.id);
    expect(projectedThread?.totalCostUsd).toBe("0.001000");
  });

  it("creates turn rows from turn.created and preserves rollups on terminal updates", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "user-1", title: "Project" });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const turn = turnFixture({
      id: "33333333-3333-4333-8333-333333333333",
      threadId: thread.id,
      role: "assistant",
      status: "streaming",
    });

    await expect(repos.turns.findById(turn.id)).resolves.toBeNull();
    await projectReadModelEvent(repos, { type: "turn.created", turn });

    expect(await repos.turns.listByThread(thread.id)).toHaveLength(1);
    expect(await repos.turns.findById(turn.id)).toMatchObject({
      id: turn.id,
      createdAt: turn.createdAt,
      status: "streaming",
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: "0",
      responseCount: 0,
    });

    await projectReadModelEvent(repos, {
      type: "model.response_received",
      response: {
        id: "44444444-4444-4444-8444-444444444444",
        turnId: turn.id,
        sequence: 0,
        provider: "stub",
        model: "stub-model",
        inputTokens: 9,
        outputTokens: 13,
        reasoningTokens: 4,
        cacheReadTokens: 6,
        cacheWriteTokens: 8,
        costUsd: "0.123000",
        millicredits: "123",
        priceSource: "provider_reported",
        finishReason: "end_turn",
      },
    });

    await projectReadModelEvent(repos, {
      type: "turn.completed",
      turn: {
        ...turn,
        status: "complete",
        finishReason: "end_turn",
        completedAt: "2026-01-02T03:04:06.000Z",
      },
    });

    expect(await repos.turns.listByThread(thread.id)).toHaveLength(1);
    expect(await repos.turns.findById(turn.id)).toMatchObject({
      status: "complete",
      finishReason: "end_turn",
      completedAt: "2026-01-02T03:04:06.000Z",
      inputTokens: 9,
      outputTokens: 13,
      reasoningTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
      totalCostUsd: "0.123000",
      totalMillicredits: "123",
      responseCount: 1,
      model: "stub-model",
      provider: "stub",
    });
  });

  it("clears the previous errored assistant projection on the next user turn without deleting the journal error", async () => {
    const projects = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects });
    const journal = createInMemoryEventJournalWriter();
    const project = await projects.create({ userId: "user-1", title: "Project" });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const erroredAssistant = turnFixture({
      id: "55555555-5555-4555-8555-555555555555",
      threadId: thread.id,
      role: "assistant",
      status: "streaming",
    });
    const assistantError: Turn = {
      ...erroredAssistant,
      status: "error",
      finishReason: "error",
      error: "provider failed",
      completedAt: "2026-01-02T03:04:06.000Z",
    };
    const nextUserTurn = turnFixture({
      id: "66666666-6666-4666-8666-666666666666",
      threadId: thread.id,
      prevTurnId: erroredAssistant.id,
      role: "user",
      status: "complete",
    });
    const events: OrchestratorEvent[] = [
      { type: "turn.created", turn: erroredAssistant },
      {
        type: "turn.error",
        turn: assistantError,
        error: {
          code: "provider_error",
          message: "provider failed",
          retryable: false,
          source: "gateway",
        },
      },
      { type: "turn.created", turn: nextUserTurn },
    ];

    for (const event of events) {
      await journal.appendEvent(thread.id, event);
      await projectReadModelEvent(repos, event);
    }

    await expect(repos.turns.findById(erroredAssistant.id)).resolves.toMatchObject({
      status: "complete",
      error: null,
      finishReason: "error",
      completedAt: "2026-01-02T03:04:06.000Z",
    });

    const journalErrors = await journal.listByType(thread.id, "turn.error");
    expect(journalErrors).toHaveLength(1);
    expect(journalErrors[0]?.payload).toMatchObject({
      type: "turn.error",
      error: {
        code: "provider_error",
        message: "provider failed",
        retryable: false,
        source: "gateway",
      },
      turn: { id: erroredAssistant.id, status: "error", error: "provider failed" },
    });
  });
});
