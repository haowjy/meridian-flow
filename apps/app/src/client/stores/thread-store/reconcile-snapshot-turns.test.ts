/**
 * reconcile-snapshot-turns tests — guards the identity-based snapshot merge.
 *
 * These cases protect the future unified-block wiring: server rows win by
 * turn/block identity, while optimistic turns and live tail blocks remain
 * stable without any timestamp watermark.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { OPTIMISTIC_TURN_ID_PREFIX } from "./optimistic-turn-id";
import { reconcileSnapshotTurns } from "./reconcile-snapshot-turns";

function block(turnId: string, sequence: number, text: string, status: "complete" | "partial") {
  return {
    id: `${turnId}-block-${sequence}-${text}`,
    turnId,
    responseId: null,
    blockType: "text",
    sequence,
    textContent: text,
    content: { text },
    provider: null,
    providerData: null,
    executionSide: "server",
    status,
    collapsedContent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  } satisfies Block;
}

function turn(id: string, blocks: Block[] = [], status: Turn["status"] = "complete"): Turn {
  return {
    id,
    threadId: "thread-1",
    prevTurnId: null,
    role: id.startsWith(OPTIMISTIC_TURN_ID_PREFIX) ? "user" : "assistant",
    status,
    finishReason: null,
    error: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    blocks,
    siblingIds: [],
    responses: [],
  };
}

type ReconcileCase = {
  name: string;
  local: Turn[];
  server: Turn[];
  expectedTurnIds: string[];
  expectedBlocksByTurn?: Record<string, string[]>;
};

const cases: ReconcileCase[] = [
  {
    name: "server-wins for shared turn ids and shared block sequences",
    local: [turn("turn-1", [block("turn-1", 0, "local", "partial")], "streaming")],
    server: [turn("turn-1", [block("turn-1", 0, "server", "complete")], "complete")],
    expectedTurnIds: ["turn-1"],
    expectedBlocksByTurn: { "turn-1": ["server"] },
  },
  {
    name: "local-tail-survives beyond the live server snapshot range",
    local: [
      turn("turn-1", [
        block("turn-1", 0, "local-head", "partial"),
        block("turn-1", 1, "local-tail", "partial"),
      ]),
    ],
    server: [turn("turn-1", [block("turn-1", 0, "server-head", "complete")], "streaming")],
    expectedTurnIds: ["turn-1"],
    expectedBlocksByTurn: { "turn-1": ["server-head", "local-tail"] },
  },
  {
    name: "terminal server turn drops local partial tail",
    local: [
      turn("turn-1", [
        block("turn-1", 0, "local-head", "partial"),
        block("turn-1", 1, "local-partial-tail", "partial"),
      ]),
    ],
    server: [turn("turn-1", [block("turn-1", 0, "server-head", "complete")], "complete")],
    expectedTurnIds: ["turn-1"],
    expectedBlocksByTurn: { "turn-1": ["server-head"] },
  },
  {
    name: "terminal server turn with complete blocks remains server-authoritative",
    local: [turn("turn-1", [block("turn-1", 2, "local-tail", "partial")], "streaming")],
    server: [
      turn(
        "turn-1",
        [
          block("turn-1", 0, "server-head", "complete"),
          block("turn-1", 1, "server-final", "complete"),
        ],
        "complete",
      ),
    ],
    expectedTurnIds: ["turn-1"],
    expectedBlocksByTurn: { "turn-1": ["server-head", "server-final"] },
  },
  {
    name: "server snapshot order wins for shared turn ids",
    local: [turn("turn-b"), turn("turn-a")],
    server: [turn("turn-a"), turn("turn-b")],
    expectedTurnIds: ["turn-a", "turn-b"],
  },
  {
    name: "optimistic-survives when absent from the server set",
    local: [turn("turn_local_1"), turn("turn-server")],
    server: [turn("turn-server")],
    expectedTurnIds: ["turn_local_1", "turn-server"],
  },
  {
    name: "server-origin local-only turn is dropped when absent from the server set",
    local: [
      turn("turn_local_1"),
      turn("123e4567-e89b-42d3-a456-426614174000"),
      turn("turn-server"),
    ],
    server: [turn("turn-server")],
    expectedTurnIds: ["turn_local_1", "turn-server"],
  },
  {
    name: "block-by-sequence head and tail merge",
    local: [turn("turn-1", [block("turn-1", 2, "tail", "partial")])],
    server: [
      turn(
        "turn-1",
        [block("turn-1", 0, "head-0", "complete"), block("turn-1", 1, "head-1", "complete")],
        "streaming",
      ),
    ],
    expectedTurnIds: ["turn-1"],
    expectedBlocksByTurn: { "turn-1": ["head-0", "head-1", "tail"] },
  },
  {
    name: "no-duplicate-turns when local contains repeated ids",
    local: [turn("turn-1"), turn("turn-1")],
    server: [turn("turn-1")],
    expectedTurnIds: ["turn-1"],
  },
  {
    name: "empty-server preserves only explicitly optimistic local turns",
    local: [turn("turn_local_1"), turn("turn-1", [block("turn-1", 0, "tail", "partial")])],
    server: [],
    expectedTurnIds: ["turn_local_1"],
  },
];

describe("reconcileSnapshotTurns", () => {
  it.each(cases)("$name", ({ local, server, expectedTurnIds, expectedBlocksByTurn }) => {
    const reconciled = reconcileSnapshotTurns(local, server);

    expect(reconciled.map((reconciledTurn) => reconciledTurn.id)).toEqual(expectedTurnIds);
    for (const [turnId, expectedTexts] of Object.entries(expectedBlocksByTurn ?? {})) {
      expect(
        reconciled
          .find((reconciledTurn) => reconciledTurn.id === turnId)
          ?.blocks.map((reconciledBlock) => reconciledBlock.textContent),
      ).toEqual(expectedTexts);
    }
  });

  it("preserves the lifecycle running turn even when it is absent from server turns", () => {
    const runningTurn = turn("turn-running", [block("turn-running", 0, "live-tail", "partial")]);

    const reconciled = reconcileSnapshotTurns([runningTurn], [], {
      runningTurnId: "turn-running",
    });

    expect(reconciled).toEqual([runningTurn]);
  });
});
