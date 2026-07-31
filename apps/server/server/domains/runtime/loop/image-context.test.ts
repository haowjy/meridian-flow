/** Capability and missing-asset degradation coverage for image context projection. */

import type { Block } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_MODEL_IMAGE_BYTES,
  MAX_MODEL_IMAGE_CONTEXT_BYTES,
  projectImageBlocksForModel,
} from "./image-context.js";

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
          return {
            mediaType: "image/png",
            data: new URL("https://assets.example/map.png"),
            sizeBytes: 3,
          };
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

  it("prioritizes newest images within per-image and aggregate byte budgets", async () => {
    const oldest = {
      ...imageBlock,
      id: "oldest",
      content: { ...imageBlock.content, documentId: "oldest" },
    };
    const middle = {
      ...imageBlock,
      id: "middle",
      content: { ...imageBlock.content, documentId: "middle" },
    };
    const newest = {
      ...imageBlock,
      id: "newest",
      content: { ...imageBlock.content, documentId: "newest" },
    };
    const resolve = vi.fn(
      async (
        _context: unknown,
        reference: { documentId: string },
        options: { maxBytes: number },
      ) => ({
        mediaType: "image/png",
        data: reference.documentId,
        sizeBytes: Math.min(MAX_MODEL_IMAGE_BYTES, options.maxBytes),
      }),
    );

    const projected = await projectImageBlocksForModel({
      thread: { id: "thread-1", projectId: "project-1" },
      blocks: [oldest, middle, newest],
      supportsImageInput: true,
      imageAssets: { isValidReference: vi.fn(), resolve },
    });

    expect(projected.map((block) => block.id)).toEqual(["middle", "newest"]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0]?.[2]).toEqual({ maxBytes: MAX_MODEL_IMAGE_BYTES });
    expect(MAX_MODEL_IMAGE_CONTEXT_BYTES).toBe(2 * MAX_MODEL_IMAGE_BYTES);
  });

  it("reads duplicate image references once while accounting for each occurrence", async () => {
    const resolve = vi.fn().mockResolvedValue({
      mediaType: "image/png",
      data: "encoded",
      sizeBytes: 1024,
    });

    const projected = await projectImageBlocksForModel({
      thread: { id: "thread-1", projectId: "project-1" },
      blocks: [imageBlock, { ...imageBlock, id: "image-copy", sequence: 2 }],
      supportsImageInput: true,
      imageAssets: { isValidReference: vi.fn(), resolve },
    });

    expect(projected).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not let pruned history consume the live image budget", async () => {
    const resolve = vi.fn().mockResolvedValue({
      mediaType: "image/png",
      data: "encoded",
      sizeBytes: MAX_MODEL_IMAGE_BYTES,
    });
    const projected = await projectImageBlocksForModel({
      thread: { id: "thread-1", projectId: "project-1" },
      blocks: [
        imageBlock,
        { ...imageBlock, id: "pruned-1", sequence: 2, pruned: true },
        { ...imageBlock, id: "pruned-2", sequence: 3, pruned: true },
      ],
      supportsImageInput: true,
      imageAssets: { isValidReference: vi.fn(), resolve },
    });

    expect(projected.map((block) => block.id)).toEqual(["image"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
