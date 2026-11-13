/**
 * Builds the durable text/reference/image blocks for a writer's user turn. Shared
 * by the direct orchestrated run (child prompt) and the writer producer, so a
 * writer send persisted at enqueue and a run-start turn are byte-identical.
 */
import {
  type AdmittedMessageBlock,
  referenceOccurrenceContent,
  skillOccurrenceContent,
  type UserMessageBlock,
  userMessageTurnBlock,
} from "@meridian/contracts/protocol";
import type { TurnId } from "@meridian/contracts/runtime";
import type { BlockUpsertedRow, StoredMediaPart } from "@meridian/contracts/threads";
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
    if (block.blockType === "media") {
      const content = block.content as Partial<StoredMediaPart> | null;
      return content?.type === "media" && content.ref
        ? [
            {
              type: "image",
              documentId: content.ref.documentId as never,
              uri: content.ref.uri as never,
            },
          ]
        : [];
    }
    if (block.blockType !== "text") return [];
    if (typeof block.content === "string") return [{ type: "text", text: block.content }];
    const reference = referenceOccurrenceContent(block);
    if (reference) {
      if (reference.kind === "folder") return [reference];
      const { read: _read, ...document } = reference;
      return [document];
    }
    const skill = skillOccurrenceContent(block);
    return skill ? [skill] : [];
  });
}
