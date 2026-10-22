/**
 * Builds the durable text/reference/image blocks for a writer's user turn. Shared
 * by the direct orchestrated run (child prompt) and the writer producer, so a
 * writer send persisted at enqueue and a run-start turn are byte-identical.
 */
import {
  referenceOccurrenceContent,
  skillOccurrenceContent,
  type UserMessageBlock,
  userMessageTurnBlock,
} from "@meridian/contracts/protocol";
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

/**
 * The inverse of `writerUserTurnBlocks`: a writer's stored turn blocks back to the message blocks
 * they were built from, in block order. A reference's adoption-time `read` snapshot is dropped, and
 * a block that is none of text, reference, skill or image is skipped.
 */
export function userMessageBlocksFromTurn(
  blocks: readonly { blockType: string; content: unknown; sequence?: number }[],
): UserMessageBlock[] {
  const ordered = [...blocks].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  return ordered.flatMap((block): UserMessageBlock[] => {
    if (block.blockType === "image") {
      const content = block.content as {
        type?: string;
        documentId?: string;
        uri?: string;
      } | null;
      return content?.type === "image_reference" && content.documentId && content.uri
        ? [
            {
              type: "image",
              documentId: content.documentId as never,
              uri: content.uri as never,
            },
          ]
        : [];
    }
    if (block.blockType !== "text") return [];
    if (typeof block.content === "string") return [{ type: "text", text: block.content }];
    const reference = referenceOccurrenceContent(block);
    if (reference) {
      const { read: _read, ...occurrence } = reference;
      return [occurrence];
    }
    const skill = skillOccurrenceContent(block);
    return skill ? [skill] : [];
  });
}
