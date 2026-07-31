/** Contract coverage for ordered append-block parsing and image-reference authorization. */

import { describe, expect, it, vi } from "vitest";
import type { ImageAssetPort } from "../ports/image-asset.js";
import {
  contentBlocksForUserMessage,
  InvalidUserMessageBlocksError,
  MAX_USER_MESSAGE_BLOCKS,
  MAX_USER_MESSAGE_IMAGES,
  parseUserMessageBlocks,
  validateUserMessageImageReferences,
} from "./user-message-blocks.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const uri = "manuscript://assets/map.png";

describe("user message blocks", () => {
  it("keeps plain text as the default append shape", () => {
    expect(parseUserMessageBlocks(undefined, "hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("persists ordered text and stable image references without request-time data", () => {
    const blocks = contentBlocksForUserMessage("turn-1", [
      { type: "text", text: `Look at ${uri}` },
      { type: "image", documentId, uri },
    ]);

    expect(blocks.map(({ id: _id, ...block }) => block)).toEqual([
      {
        turnId: "turn-1",
        responseId: null,
        blockType: "text",
        sequence: 0,
        content: `Look at ${uri}`,
        provider: null,
        status: "complete",
      },
      {
        turnId: "turn-1",
        responseId: null,
        blockType: "image",
        sequence: 1,
        content: { type: "image_reference", documentId, uri },
        provider: null,
        status: "complete",
      },
    ]);
  });

  it("accepts ordered text and internal image references", () => {
    expect(
      parseUserMessageBlocks(
        [
          { type: "text", text: `Look at ${uri}` },
          { type: "image", documentId, uri },
        ],
        `Look at ${uri}`,
      ),
    ).toEqual([
      { type: "text", text: `Look at ${uri}` },
      { type: "image", documentId, uri },
    ]);
  });

  it("accepts manuscript image references outside an assets folder", () => {
    const pictureUri = "manuscript://pictures/pic-1.png";
    expect(
      parseUserMessageBlocks(
        [
          { type: "text", text: `Look at ${pictureUri}` },
          { type: "image", documentId, uri: pictureUri },
        ],
        `Look at ${pictureUri}`,
      ),
    ).toEqual([
      { type: "text", text: `Look at ${pictureUri}` },
      { type: "image", documentId, uri: pictureUri },
    ]);
  });

  it.each([
    [[{ type: "image", documentId, uri }], `Look at ${uri}`],
    [
      [
        { type: "text", text: "different" },
        { type: "image", documentId, uri },
      ],
      `Look at ${uri}`,
    ],
    [
      [
        { type: "text", text: "Look at it" },
        { type: "image", documentId, uri },
      ],
      "Look at it",
    ],
    [
      [
        { type: "text", text: `Look at ${uri}` },
        { type: "image", documentId: "not-an-id", uri },
      ],
      `Look at ${uri}`,
    ],
    [
      [
        { type: "text", text: "Look at https://example.com/map.png" },
        { type: "image", documentId, uri: "https://example.com/map.png" },
      ],
      "Look at https://example.com/map.png",
    ],
  ])("rejects malformed or divergent block payloads", (blocks, text) => {
    expect(() => parseUserMessageBlocks(blocks, text)).toThrow(InvalidUserMessageBlocksError);
  });

  it("bounds block and image fan-out", () => {
    expect(() =>
      parseUserMessageBlocks(
        Array.from({ length: MAX_USER_MESSAGE_BLOCKS + 1 }, () => ({
          type: "text",
          text: "x",
        })),
        "x".repeat(MAX_USER_MESSAGE_BLOCKS + 1),
      ),
    ).toThrow(/at most 64 entries/);

    const text = `Look at ${uri}`;
    expect(() =>
      parseUserMessageBlocks(
        [
          { type: "text", text },
          ...Array.from({ length: MAX_USER_MESSAGE_IMAGES + 1 }, () => ({
            type: "image",
            documentId,
            uri,
          })),
        ],
        text,
      ),
    ).toThrow(/at most 16 images/);
  });

  it("authorizes every image through the asset port without capability gating", async () => {
    const isValidReference = vi.fn().mockResolvedValue(true);
    const imageAssets = {
      isValidReference,
      resolve: vi.fn(),
    } satisfies ImageAssetPort;
    const blocks = parseUserMessageBlocks(
      [
        { type: "text", text: `Look at ${uri}` },
        { type: "image", documentId, uri },
      ],
      `Look at ${uri}`,
    );

    await validateUserMessageImageReferences(
      blocks,
      { projectId: "project-1", threadId: "thread-1" },
      imageAssets,
    );

    expect(isValidReference).toHaveBeenCalledWith(
      { projectId: "project-1", threadId: "thread-1" },
      { type: "image_reference", documentId, uri },
    );
  });

  it("deduplicates authorization for repeated identical references", async () => {
    const isValidReference = vi.fn().mockResolvedValue(true);
    await validateUserMessageImageReferences(
      [
        { type: "text", text: uri },
        { type: "image", documentId, uri },
        { type: "image", documentId, uri },
      ],
      { projectId: "project-1", threadId: "thread-1" },
      { isValidReference, resolve: vi.fn() },
    );

    expect(isValidReference).toHaveBeenCalledTimes(1);
  });

  it("rejects image references unavailable to the thread", async () => {
    const blocks = parseUserMessageBlocks(
      [
        { type: "text", text: `Look at ${uri}` },
        { type: "image", documentId, uri },
      ],
      `Look at ${uri}`,
    );

    await expect(
      validateUserMessageImageReferences(
        blocks,
        { projectId: "project-1", threadId: "thread-1" },
        {
          async isValidReference() {
            return false;
          },
          async resolve() {
            return null;
          },
        },
      ),
    ).rejects.toThrow(/available to this thread/);
  });
});
