/**
 * Builds the durable text/reference/image blocks for a writer's user turn. Shared
 * by the direct orchestrated run (child prompt) and the writer producer, so a
 * writer send persisted at enqueue and a run-start turn are byte-identical.
 */
import { type UserMessageBlock, userMessageTurnBlock } from "@meridian/contracts/protocol";
import type { TurnId } from "@meridian/contracts/runtime";
import type { BlockUpsertedRow } from "@meridian/contracts/threads";
import { contentForBlockInput } from "./block-helpers.js";

export function writerUserTurnBlocks(
  userTurnId: TurnId,
  blocks: readonly UserMessageBlock[],
): BlockUpsertedRow[] {
  return blocks.map((block, sequence) =>
    contentForBlockInput({
      turnId: userTurnId,
      sequence,
      status: "complete",
      ...userMessageTurnBlock(block),
    }),
  );
}
