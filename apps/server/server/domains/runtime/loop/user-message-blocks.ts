/** Validation and persistence projection for ordered user-message append blocks. */

import { parseContextUri } from "@meridian/contracts/context-uri";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { TurnId } from "@meridian/contracts/runtime";
import type {
  BlockUpsertedRow,
  PersistedImageReference,
  UserMessageBlock,
} from "@meridian/contracts/threads";
import type { ImageAssetContext, ImageAssetPort } from "../ports/image-asset.js";
import { contentForBlockInput } from "./block-helpers.js";

export class InvalidUserMessageBlocksError extends Error {}

export const MAX_USER_MESSAGE_BLOCKS = 64;
export const MAX_USER_MESSAGE_IMAGES = 16;

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseUserMessageBlocks(value: unknown, fallbackText: string): UserMessageBlock[] {
  if (value === undefined) return [{ type: "text", text: fallbackText }];
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidUserMessageBlocksError("blocks must be a non-empty array");
  }
  if (value.length > MAX_USER_MESSAGE_BLOCKS) {
    throw new InvalidUserMessageBlocksError(
      `blocks must contain at most ${MAX_USER_MESSAGE_BLOCKS} entries`,
    );
  }

  const blocks = value.map((candidate, index): UserMessageBlock => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new InvalidUserMessageBlocksError(`blocks[${index}] must be an object`);
    }
    const type = (candidate as { type?: unknown }).type;
    if (type === "text") {
      if (!isExactObject(candidate, ["type", "text"]) || typeof candidate.text !== "string") {
        throw new InvalidUserMessageBlocksError(`blocks[${index}] is not a valid text block`);
      }
      if (candidate.text.length === 0) {
        throw new InvalidUserMessageBlocksError(`blocks[${index}].text must not be empty`);
      }
      return { type, text: candidate.text };
    }
    if (type === "image") {
      if (
        !isExactObject(candidate, ["type", "documentId", "uri"]) ||
        typeof candidate.documentId !== "string" ||
        typeof candidate.uri !== "string"
      ) {
        throw new InvalidUserMessageBlocksError(`blocks[${index}] is not a valid image block`);
      }
      const documentId = parseRequestId(candidate.documentId);
      const parsedUri = parseContextUri(candidate.uri);
      if (!documentId) {
        throw new InvalidUserMessageBlocksError(
          `blocks[${index}].documentId must be a canonical UUID`,
        );
      }
      if (
        !candidate.uri.includes("://") ||
        !parsedUri.ok ||
        (parsedUri.value.scheme === "manuscript"
          ? !parsedUri.value.path.startsWith("assets/")
          : parsedUri.value.scheme !== "uploads") ||
        parsedUri.value.path.length === 0
      ) {
        throw new InvalidUserMessageBlocksError(
          `blocks[${index}].uri must name a manuscript asset or thread upload`,
        );
      }
      return { type, documentId, uri: parsedUri.value.canonical };
    }
    throw new InvalidUserMessageBlocksError(`blocks[${index}].type is not supported`);
  });

  const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  if (text !== fallbackText) {
    throw new InvalidUserMessageBlocksError("text must equal the concatenated text blocks");
  }
  for (const [index, block] of blocks.entries()) {
    if (block.type === "image" && !fallbackText.includes(block.uri)) {
      throw new InvalidUserMessageBlocksError(
        `blocks[${index}].uri must also appear in the message text`,
      );
    }
  }
  const imageCount = blocks.filter((block) => block.type === "image").length;
  if (imageCount > MAX_USER_MESSAGE_IMAGES) {
    throw new InvalidUserMessageBlocksError(
      `blocks must contain at most ${MAX_USER_MESSAGE_IMAGES} images`,
    );
  }
  return blocks;
}

export async function validateUserMessageImageReferences(
  blocks: readonly UserMessageBlock[],
  context: ImageAssetContext,
  imageAssets: ImageAssetPort,
): Promise<void> {
  const validity = new Map<string, Promise<boolean>>();
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "image") continue;
    const reference = persistedImageReference(block);
    const key = `${reference.documentId}\0${reference.uri}`;
    const valid = validity.get(key) ?? imageAssets.isValidReference(context, reference);
    validity.set(key, valid);
    if (!(await valid)) {
      throw new InvalidUserMessageBlocksError(
        `blocks[${index}] does not reference an image available to this thread`,
      );
    }
  }
}

export function persistedImageReference(
  block: Extract<UserMessageBlock, { type: "image" }>,
): PersistedImageReference {
  return {
    type: "image_reference",
    documentId: block.documentId,
    uri: block.uri,
  };
}

export function contentBlocksForUserMessage(
  turnId: TurnId,
  blocks: readonly UserMessageBlock[],
): BlockUpsertedRow[] {
  return blocks.map((block, sequence) =>
    block.type === "text"
      ? contentForBlockInput({
          turnId,
          blockType: "text",
          sequence,
          textContent: block.text,
          status: "complete",
        })
      : contentForBlockInput({
          turnId,
          blockType: "image",
          sequence,
          content: { ...persistedImageReference(block) },
          status: "complete",
        }),
  );
}
