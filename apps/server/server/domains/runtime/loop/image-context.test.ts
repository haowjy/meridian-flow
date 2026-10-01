import type { Block, Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { type ImageAssetPort, ImageAssetResolutionError } from "../ports/image-asset.js";
import { MAX_MODEL_IMAGE_CONTEXT_BYTES, projectImageBlocksForModel } from "./image-context.js";

const thread: Pick<Thread, "id" | "projectId" | "userId"> = {
  id: "thread-1",
  projectId: "project-1",
  userId: "user-1",
};

const imageBlock: Block = {
  id: "image-1",
  turnId: "turn-1",
  responseId: null,
  blockType: "image",
  sequence: 0,
  content: {
    type: "image_reference",
    documentId: "document-1",
    uri: "scratch://image.png",
  },
  createdAt: "2026-09-27T12:00:00.000Z",
};

const missingImageAsset: ImageAssetPort = {
  async resolve() {
    return null;
  },
};

function image(id: string): Block {
  return {
    ...imageBlock,
    id,
    content: {
      type: "image_reference",
      documentId: `document-${id}`,
      uri: `scratch://${id}.png`,
    },
  };
}

function assets(sizes: ReadonlyMap<string, number>): ImageAssetPort {
  return {
    async resolve(_context, identity) {
      const sizeBytes = sizes.get(identity.documentId);
      if (sizeBytes === undefined) return null;
      return { mediaType: "image/png", data: identity.uri, sizeBytes };
    },
  };
}

function imageIds(blocks: readonly Block[]) {
  return blocks.map((block) => block.id);
}

describe("projectImageBlocksForModel", () => {
  it("names a missing asset according to whether it was previously included", async () => {
    const previouslyIncluded = await projectImageBlocksForModel({
      thread,
      blocks: [imageBlock],
      inclusions: new Map([[imageBlock.id, true]]),
      supportsImageInput: true,
      imageAssets: missingImageAsset,
    });
    const firstSight = await projectImageBlocksForModel({
      thread,
      blocks: [imageBlock],
      supportsImageInput: true,
      imageAssets: missingImageAsset,
    });

    expect(previouslyIncluded.breaks).toEqual([
      {
        blockId: imageBlock.id,
        uri: "scratch://image.png",
        reason: "asset_unavailable",
      },
    ]);
    expect(firstSight.breaks).toEqual([
      {
        blockId: imageBlock.id,
        uri: "scratch://image.png",
        reason: "asset_unavailable_first_sight",
      },
    ]);
  });

  it("fills free budget with excluded retained candidates, newest first", async () => {
    const mib = 1024 * 1024;
    const candidates = [image("old"), image("middle"), image("new")];
    const projection = await projectImageBlocksForModel({
      thread,
      blocks: candidates,
      inclusions: new Map(candidates.map((block) => [block.id, false])),
      supportsImageInput: true,
      imageAssets: assets(
        new Map(
          candidates.map((block) => [
            `document-${block.id}`,
            block.id === "old" ? 7 * mib : block.id === "middle" ? 8 * mib : 9 * mib,
          ]),
        ),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set(candidates.map((block) => block.id)),
        decidingTurnId: "turn-c",
      },
    });

    expect(imageIds(projection.blocks)).toEqual(["middle", "new"]);
    expect(projection.decisions).toEqual([
      { blockId: "new", included: true, decidedByCompaction: true },
      { blockId: "middle", included: true, decidedByCompaction: true },
    ]);
    expect(17 * mib).toBeLessThanOrEqual(MAX_MODEL_IMAGE_CONTEXT_BYTES);
  });

  it("does not evict included images for a candidate and keeps late-arrival eviction", async () => {
    const mib = 1024 * 1024;
    const protectedImage = image("protected");
    const protectedImage2 = image("protected-2");
    const blockedCandidate = image("blocked");
    const protectedProjection = await projectImageBlocksForModel({
      thread,
      blocks: [protectedImage, protectedImage2, blockedCandidate],
      inclusions: new Map([
        [protectedImage.id, true],
        [protectedImage2.id, true],
        [blockedCandidate.id, false],
      ]),
      supportsImageInput: true,
      imageAssets: assets(
        new Map([
          [`document-${protectedImage.id}`, 8 * mib],
          [`document-${protectedImage2.id}`, 8 * mib],
          [`document-${blockedCandidate.id}`, 5 * mib],
        ]),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set([blockedCandidate.id]),
        decidingTurnId: "turn-c",
      },
    });

    expect(imageIds(protectedProjection.blocks)).toEqual(["protected", "protected-2"]);
    expect(protectedProjection.decisions).toEqual([]);
    expect(protectedProjection.breaks).toEqual([]);

    const included = image("included");
    const included2 = image("included-2");
    const candidate = image("candidate");
    const lateArrival = image("late");
    const blocks = [included, included2, candidate, lateArrival];
    const projection = await projectImageBlocksForModel({
      thread,
      blocks,
      inclusions: new Map([
        [included.id, true],
        [included2.id, true],
        [candidate.id, false],
      ]),
      supportsImageInput: true,
      imageAssets: assets(
        new Map([
          [`document-${included.id}`, 10 * mib],
          [`document-${included2.id}`, 6 * mib],
          [`document-${candidate.id}`, 5 * mib],
          [`document-${lateArrival.id}`, 9 * mib],
        ]),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set([candidate.id]),
        decidingTurnId: "turn-c",
      },
    });

    // The late image applies ordinary eviction first. The candidate then fills the
    // remaining budget without being able to evict the remaining included image.
    expect(imageIds(projection.blocks)).toEqual(["included-2", "candidate", "late"]);
    expect(projection.decisions).toEqual([
      { blockId: "candidate", included: true, decidedByCompaction: true },
      { blockId: "included", included: false },
      { blockId: "late", included: true },
    ]);
  });

  it("lets a late arrival use the existing image budget before re-admitting candidates", async () => {
    const mib = 1024 * 1024;
    const included = image("included");
    const candidate = image("candidate");
    const lateArrival = image("late");
    const projection = await projectImageBlocksForModel({
      thread,
      blocks: [included, candidate, lateArrival],
      inclusions: new Map([
        [included.id, true],
        [candidate.id, false],
      ]),
      supportsImageInput: true,
      imageAssets: assets(
        new Map([
          [`document-${included.id}`, 8 * mib],
          [`document-${candidate.id}`, 8 * mib],
          [`document-${lateArrival.id}`, 8 * mib],
        ]),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set([candidate.id]),
        decidingTurnId: "turn-c",
      },
    });

    expect(imageIds(projection.blocks)).toEqual(["included", "late"]);
    expect(projection.decisions).toEqual([{ blockId: "late", included: true }]);
    expect(projection.breaks).toEqual([]);
  });

  it("does not decide or announce a candidate twice when it precedes included images", async () => {
    const mib = 1024 * 1024;
    const candidate = image("candidate");
    const included = image("included");
    const lateArrival = image("late");
    const projection = await projectImageBlocksForModel({
      thread,
      blocks: [candidate, included, lateArrival],
      inclusions: new Map([
        [candidate.id, false],
        [included.id, true],
      ]),
      supportsImageInput: true,
      imageAssets: assets(
        new Map([
          [`document-${candidate.id}`, 8 * mib],
          [`document-${included.id}`, 8 * mib],
          [`document-${lateArrival.id}`, 8 * mib],
        ]),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set([candidate.id]),
        decidingTurnId: "turn-c",
      },
    });

    expect(imageIds(projection.blocks)).toEqual(["included", "late"]);
    expect(projection.decisions).toEqual([{ blockId: "late", included: true }]);
    expect(projection.breaks).toEqual([]);
    expect(projection.breaks.some(({ uri }) => uri === "scratch://candidate.png")).toBe(false);
  });

  it("skips a transient candidate failure without deciding or failing", async () => {
    const candidate = image("candidate");
    let attempts = 0;
    const projection = await projectImageBlocksForModel({
      thread,
      blocks: [candidate],
      inclusions: new Map([[candidate.id, false]]),
      supportsImageInput: true,
      imageAssets: {
        async resolve() {
          attempts++;
          throw new ImageAssetResolutionError("object store timed out");
        },
      },
      mode: {
        kind: "compaction",
        candidates: new Set([candidate.id]),
        decidingTurnId: "turn-c",
      },
    });

    expect(projection.blocks).toEqual([]);
    expect(attempts).toBe(1);
    expect(projection.decisions).toEqual([]);
    expect(projection.breaks).toEqual([]);
  });

  it("rethrows unexpected candidate resolution errors", async () => {
    const candidate = image("candidate");
    await expect(
      projectImageBlocksForModel({
        thread,
        blocks: [candidate],
        inclusions: new Map([[candidate.id, false]]),
        supportsImageInput: true,
        imageAssets: {
          async resolve() {
            throw new Error("adapter bug");
          },
        },
        mode: {
          kind: "compaction",
          candidates: new Set([candidate.id]),
          decidingTurnId: "turn-c",
        },
      }),
    ).rejects.toThrow("adapter bug");
  });

  it("stops candidate resolution when the signal aborts", async () => {
    const first = image("first");
    const second = image("second");
    const controller = new AbortController();
    let attempts = 0;

    await expect(
      projectImageBlocksForModel({
        thread,
        blocks: [first, second],
        inclusions: new Map([
          [first.id, false],
          [second.id, false],
        ]),
        supportsImageInput: true,
        imageAssets: {
          async resolve() {
            attempts++;
            controller.abort();
            throw new ImageAssetResolutionError("object store timed out");
          },
        },
        mode: {
          kind: "compaction",
          candidates: new Set([first.id, second.id]),
          decidingTurnId: "turn-c",
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });
});
