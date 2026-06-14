// @ts-nocheck
/**
 * build-optimistic-user-turn — constructs an optimistic domain `Turn` for a
 * just-submitted user message (client UUID, timestamp from store `now`). Pure
 * factory used by the optimistic submit flow before the server reconciles.
 */
import type { Turn } from "@meridian/contracts/protocol";

import { baseTurnFields } from "@/core/session/state-helpers";

export function buildOptimisticUserTurn(input: {
  id: string;
  threadId: string;
  text: string;
  now: number;
  prevTurnId?: string | null;
}): Turn {
  const timestamp = new Date(input.now).toISOString();
  return {
    id: input.id,
    threadId: input.threadId,
    prevTurnId: input.prevTurnId ?? null,
    role: "user",
    status: "complete",
    finishReason: null,
    error: null,
    model: null,
    provider: null,
    ...baseTurnFields(),
    createdAt: timestamp,
    completedAt: timestamp,
    blocks: [
      {
        id: `${input.id}_block_1`,
        turnId: input.id,
        responseId: null,
        blockType: "text",
        sequence: 0,
        textContent: input.text,
        content: { text: input.text },
        provider: null,
        providerData: null,
        collapsedContent: null,
        executionSide: null,
        status: "complete",
        createdAt: timestamp,
      },
    ],
    siblingIds: [],
    responses: [],
  };
}
