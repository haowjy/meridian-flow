/**
 * order-turns tests — regression coverage for causal snapshot ordering when
 * wall-clock turn timestamps tie. The helper is pure so the same ordering
 * contract can be tested without repository or SQL ordering noise.
 */
import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

import { orderTurnsCausally } from "./order-turns.js";

function turn(id: string, prevTurnId: string | null, createdAt: string): Turn {
  return {
    id,
    threadId: "thread-1",
    prevTurnId,
    parentTurnId: prevTurnId,
    role: id.includes("user") ? "user" : "assistant",
    status: "complete",
    finishReason: null,
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    requestParams: null,
    responseMetadata: null,
    createdAt,
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function ids(turns: Turn[]): string[] {
  return turns.map((orderedTurn) => orderedTurn.id);
}

describe("orderTurnsCausally", () => {
  it("orders a same-createdAt user/assistant tie by prevTurnId regardless of input order", () => {
    const createdAt = "2026-06-08T00:00:00.000Z";
    const user = turn("turn-user", null, createdAt);
    const assistant = turn("turn-assistant", user.id, createdAt);

    expect(ids(orderTurnsCausally([assistant, user]))).toEqual(["turn-user", "turn-assistant"]);
    expect(ids(orderTurnsCausally([user, assistant]))).toEqual(["turn-user", "turn-assistant"]);
  });

  it("keeps a three-turn chain parent-before-child even when the input is reversed", () => {
    const createdAt = "2026-06-08T00:00:00.000Z";
    const user = turn("turn-user", null, createdAt);
    const assistant = turn("turn-assistant", user.id, createdAt);
    const followup = turn("turn-followup-assistant", assistant.id, createdAt);

    expect(ids(orderTurnsCausally([followup, assistant, user]))).toEqual([
      "turn-user",
      "turn-assistant",
      "turn-followup-assistant",
    ]);
  });

  it("treats missing-parent turns as fallback-sorted roots without dropping descendants", () => {
    const orphan = turn("turn-orphan", "missing-parent", "2026-06-08T00:00:02.000Z");
    const root = turn("turn-root", null, "2026-06-08T00:00:01.000Z");
    const child = turn("turn-child", orphan.id, "2026-06-08T00:00:00.000Z");

    expect(ids(orderTurnsCausally([child, orphan, root]))).toEqual([
      "turn-root",
      "turn-orphan",
      "turn-child",
    ]);
  });
});
