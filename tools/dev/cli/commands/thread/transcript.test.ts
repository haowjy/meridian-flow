/** Failed compaction metadata is visible in the existing thread transcript view. */

import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { compactTurn, renderThreadView } from "./transcript.js";

describe("thread transcript compaction failures", () => {
  it("shows a failed compaction's reason and phase in JSON and text output", () => {
    const turn = {
      id: "compaction-id",
      threadId: "thread-id",
      position: 1,
      writeMode: null,
      promptBakeId: null,
      role: "compaction",
      origin: "assistant",
      status: "error",
      finishReason: null,
      model: null,
      error: "This message is too long for this chat's model.",
      metadata: {
        reason: "context_too_large",
        phase: "initial_prepare",
        trigger: "auto",
        controlMessageId: "control-id",
        estimatedTokens: 12_001,
        fitLimitTokens: 12_000,
      },
      createdAt: "2026-09-27T00:00:00.000Z",
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: "0",
      responseCount: 0,
      usage: null,
      completedAt: null,
      blocks: [],
      siblingIds: [],
      responses: [],
    } as Turn;
    const compact = compactTurn(turn, { full: false });
    expect(compact.compactionMetadata).toEqual({
      trigger: "auto",
      controlMessageId: "control-id",
      reason: "context_too_large",
      phase: "initial_prepare",
      estimatedTokens: 12_001,
      fitLimitTokens: 12_000,
    });

    expect(
      renderThreadView({
        thread: {
          id: "thread-id",
          ref: null,
          title: null,
          projectId: "project-id",
          workId: null,
          agentName: null,
          status: "idle",
          turnCount: 1,
          totalCostUsd: "0",
        },
        live: { status: "asleep", runningTurnId: null, pending: 0, actionRequired: false },
        turns: [compact],
        showing: 1,
        total: 1,
      }),
    ).toContain("compaction failure: context_too_large during initial_prepare");
  });

  it("includes summary token counts from the compaction block", () => {
    const turn = {
      id: "compaction-id",
      threadId: "thread-id",
      position: 1,
      writeMode: null,
      promptBakeId: null,
      role: "compaction",
      origin: "system",
      status: "complete",
      finishReason: null,
      model: null,
      error: null,
      metadata: { trigger: "manual" },
      createdAt: "2026-09-27T00:00:00.000Z",
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: "0",
      responseCount: 0,
      usage: null,
      completedAt: null,
      blocks: [
        {
          id: "summary-block",
          turnId: "compaction-id",
          responseId: null,
          blockType: "custom",
          sequence: 0,
          textContent: null,
          content: {
            kind: "compaction",
            props: { summary: "Summary", tokensBefore: 9_000, tokensAfter: 2_000 },
          },
          status: "complete",
          createdAt: "2026-09-27T00:00:00.000Z",
        },
      ],
      siblingIds: [],
      responses: [],
    } as Turn;

    expect(compactTurn(turn, { full: false }).compactionMetadata).toEqual({
      trigger: "manual",
      tokensBefore: 9_000,
      tokensAfter: 2_000,
    });
  });
});

it("surfaces undo metadata without replacing writer-facing error copy", () => {
  const turn = {
    id: "undo-id",
    role: "system",
    origin: "system",
    status: "error",
    error: "This compaction has already been undone.",
    metadata: {
      kind: "compaction_undo",
      revertsCompactionTurnId: "compaction-id",
      controlMessageId: "control-id",
      reason: "already_undone",
    },
    blocks: [],
  } as unknown as Turn;
  expect(compactTurn(turn, { full: false })).toMatchObject({
    error: "This compaction has already been undone.",
    compactionUndoMetadata: {
      revertsCompactionTurnId: "compaction-id",
      controlMessageId: "control-id",
      reason: "already_undone",
    },
  });
});
