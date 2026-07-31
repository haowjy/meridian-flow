/** Capability and missing-asset degradation coverage for image context projection. */

import type { Block } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { projectImageBlocksForModel } from "./image-context.js";

const textBlock = {
  id: "text",
  turnId: "turn-1",
  responseId: null,
  blockType: "text",
  sequence: 0,
  content: "Look at manuscript://assets/map.png",
  textContent: "Look at manuscript://assets/map.png",
  createdAt: "2026-07-30T00:00:00.000Z",
} satisfies Block;
const imageBlock = {
  id: "image",
  turnId: "turn-1",
  responseId: null,
  blockType: "image",
  sequence: 1,
  content: {
    type: "image_reference",
    documentId: "11111111-1111-4111-8111-111111111111",
    uri: "manuscript://assets/map.png",
  },
  createdAt: "2026-07-30T00:00:00.000Z",
} satisfies Block;

describe("projectImageBlocksForModel", () => {
  it("quietly drops images for models without image_input", async () => {
    const resolve = vi.fn();
    const projected = await projectImageBlocksForModel({
      thread: { id: "thread-1", projectId: "project-1" },
      blocks: [textBlock, imageBlock],
      supportsImageInput: false,
      imageAssets: { isValidReference: vi.fn(), resolve },
    });

    expect(projected).toEqual([textBlock]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves image references into canonical image content", async () => {
    const projected = await projectImageBlocksForModel({
      thread: { id: "thread-1", projectId: "project-1" },
      blocks: [textBlock, imageBlock],
      supportsImageInput: true,
      imageAssets: {
        isValidReference: vi.fn(),
        async resolve() {
          return { mediaType: "image/png", data: new URL("https://assets.example/map.png") };
        },
      },
    });

    expect(projected).toEqual([
      textBlock,
      {
        ...imageBlock,
        content: {
          type: "image",
          mediaType: "image/png",
          data: "https://assets.example/map.png",
        },
      },
    ]);
  });

  it("quietly drops image references that no longer resolve", async () => {
    const projected = await projectImageBlocksForModel({
      thread: { id: "thread-1", projectId: "project-1" },
      blocks: [textBlock, imageBlock],
      supportsImageInput: true,
      imageAssets: {
        isValidReference: vi.fn(),
        async resolve() {
          return null;
        },
      },
    });

    expect(projected).toEqual([textBlock]);
  });
});
