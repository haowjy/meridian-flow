/**
 * Tests image context behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Bounded image retention and refill policy
 */
import type { Block, Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { MediaResolutionError, type MediaResolverPort } from "../ports/media-resolver.js";
import { bytesMedia } from "./__tests__/media-test-support.js";
import {
  MAX_MODEL_IMAGE_CONTEXT_BYTES,
  type MediaModel,
  mediaUnitKey,
  projectImageBlocksForModel,
} from "./image-context.js";

const MODEL: MediaModel = {
  id: "gpt-5.6-luna",
  wire: "openai",
  inputModalities: ["text", "image"],
  contextWindow: 200_000,
};
const WINDOW = { startMs: 0, lengthSeconds: 3600 };
const unit = (blockId: string) => mediaUnitKey(blockId, 0);

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
    type: "media",
    ref: { documentId: "document-1", uri: "scratch://image.png" },
    mediaType: "image/png",
    sizeBytes: 5,
    name: "image.png",
  },
  createdAt: "2026-09-27T12:00:00.000Z",
};

function image(id: string): Block {
  return {
    ...imageBlock,
    id,
    content: {
      type: "media",
      ref: { documentId: `document-${id}`, uri: `scratch://${id}.png` },
      mediaType: "image/png",
      sizeBytes: 5,
      name: `${id}.png`,
    },
  };
}

function assets(sizes: ReadonlyMap<string, number>): MediaResolverPort {
  return {
    async resolve(_context, identity) {
      const sizeBytes = sizes.get(identity.documentId);
      if (sizeBytes === undefined) return null;
      return bytesMedia({ data: identity.uri, sizeBytes });
    },
  };
}

function imageIds(blocks: readonly Block[]) {
  return blocks.map((block) => block.id);
}

describe("projectImageBlocksForModel", () => {
  it("fills free budget with excluded retained candidates, newest first", async () => {
    const mib = 1024 * 1024;
    const candidates = [image("old"), image("middle"), image("new")];
    const projection = await projectImageBlocksForModel({
      thread,
      blocks: candidates,
      inclusions: new Map(candidates.map((block) => [unit(block.id), false])),
      model: MODEL,
      window: WINDOW,
      media: assets(
        new Map(
          candidates.map((block) => [
            `document-${block.id}`,
            block.id === "old" ? 7 * mib : block.id === "middle" ? 8 * mib : 9 * mib,
          ]),
        ),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set(candidates.map((block) => unit(block.id))),
        decidingTurnId: "turn-c",
      },
    });

    expect(imageIds(projection.blocks)).toEqual(["middle", "new"]);
    expect(projection.decisions).toEqual([
      { blockId: "new", partIndex: 0, included: true, decidedByCompaction: true },
      { blockId: "middle", partIndex: 0, included: true, decidedByCompaction: true },
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
        [unit(protectedImage.id), true],
        [unit(protectedImage2.id), true],
        [unit(blockedCandidate.id), false],
      ]),
      model: MODEL,
      window: WINDOW,
      media: assets(
        new Map([
          [`document-${protectedImage.id}`, 8 * mib],
          [`document-${protectedImage2.id}`, 8 * mib],
          [`document-${blockedCandidate.id}`, 5 * mib],
        ]),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set([unit(blockedCandidate.id)]),
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
        [unit(included.id), true],
        [unit(included2.id), true],
        [unit(candidate.id), false],
      ]),
      model: MODEL,
      window: WINDOW,
      media: assets(
        new Map([
          [`document-${included.id}`, 10 * mib],
          [`document-${included2.id}`, 6 * mib],
          [`document-${candidate.id}`, 5 * mib],
          [`document-${lateArrival.id}`, 9 * mib],
        ]),
      ),
      mode: {
        kind: "compaction",
        candidates: new Set([unit(candidate.id)]),
        decidingTurnId: "turn-c",
      },
    });

    // The late image evicts a chunk, oldest first, down to half the budget, so the next arrivals
    // fit without moving the cached prefix again. The candidate then fills the remaining budget.
    expect(imageIds(projection.blocks)).toEqual(["candidate", "late"]);
    expect(projection.decisions).toEqual([
      { blockId: "candidate", partIndex: 0, included: true, decidedByCompaction: true },
      { blockId: "included", partIndex: 0, included: false },
      { blockId: "included-2", partIndex: 0, included: false },
      { blockId: "late", partIndex: 0, included: true },
    ]);
  });

  it("skips a transient candidate failure without deciding or failing", async () => {
    const candidate = image("candidate");
    let attempts = 0;
    const projection = await projectImageBlocksForModel({
      thread,
      blocks: [candidate],
      inclusions: new Map([[unit(candidate.id), false]]),
      model: MODEL,
      window: WINDOW,
      media: {
        async resolve() {
          attempts++;
          throw new MediaResolutionError("object store timed out");
        },
      },
      mode: {
        kind: "compaction",
        candidates: new Set([unit(candidate.id)]),
        decidingTurnId: "turn-c",
      },
    });

    expect(projection.blocks).toEqual([]);
    expect(attempts).toBe(1);
    expect(projection.decisions).toEqual([]);
    expect(projection.breaks).toEqual([]);
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
          [unit(first.id), false],
          [unit(second.id), false],
        ]),
        model: MODEL,
        window: WINDOW,
        media: {
          async resolve() {
            attempts++;
            controller.abort();
            throw new MediaResolutionError("object store timed out");
          },
        },
        mode: {
          kind: "compaction",
          candidates: new Set([unit(first.id), unit(second.id)]),
          decidingTurnId: "turn-c",
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });
});
