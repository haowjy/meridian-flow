/**
 * build-optimistic-user-turn — constructs an optimistic domain `Turn` for a
 * just-submitted user message (client UUID, timestamp from store `now`). Pure
 * factory used by the optimistic submit flow before the server reconciles.
 * Its blocks are the submitted message blocks as the server persists them, so
 * reference and skill occurrences keep their identity before admission.
 */
import {
  blockPlainText,
  type Turn,
  type UserMessageBlock,
  userMessageTurnBlock,
} from "@meridian/contracts/protocol";

import { baseTurnFields } from "@/core/session/state-helpers";

export function buildOptimisticUserTurn(input: {
  id: string;
  threadId: string;
  blocks: readonly UserMessageBlock[];
  now: number;
  prevTurnId?: string | null;
}): Turn {
  const timestamp = new Date(input.now).toISOString();
  return {
    id: input.id,
    threadId: input.threadId,
    position: 0,
    prevTurnId: input.prevTurnId ?? null,
    role: "user",
    origin: "writer",
    writeMode: null,
    // Pending until the server admission/lookup renames this row to the
    // canonical user turn. A user row must not look settled before ack.
    status: "pending",
    promptBakeId: null,
    finishReason: null,
    error: null,
    model: null,
    provider: null,
    ...baseTurnFields(),
    createdAt: timestamp,
    completedAt: null,
    blocks: input.blocks.map((block, sequence) => {
      const { blockType, content } = userMessageTurnBlock(block);
      return {
        id: `${input.id}_block_${sequence + 1}`,
        turnId: input.id,
        responseId: null,
        blockType,
        sequence,
        textContent: blockPlainText(blockType, content),
        content,
        provider: null,
        providerData: null,
        collapsedContent: null,
        executionSide: null,
        status: "complete",
        createdAt: timestamp,
      };
    }),
    siblingIds: [],
    responses: [],
  };
}
