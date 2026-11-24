import { type AdmittedMessageBlock, userMessageTurnBlock } from "@meridian/contracts/protocol";
import type { TurnId } from "@meridian/contracts/runtime";
import type { BlockUpsertedRow } from "@meridian/contracts/threads";
import { contentForBlockInput } from "./block-helpers.js";

export function writerUserTurnBlocks(
  userTurnId: TurnId,
  blocks: readonly AdmittedMessageBlock[],
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
