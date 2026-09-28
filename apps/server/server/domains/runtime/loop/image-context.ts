/** Stable request-time projection of durable image occurrences into gateway bytes. */

import type { TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread } from "@meridian/contracts/threads";
import type { ImageContextBreak } from "../../threads/index.js";
import {
  type ImageAssetPort,
  ImageAssetResolutionError,
  type PersistedImageReference,
} from "../ports/image-asset.js";

type ResolvedImage = NonNullable<Awaited<ReturnType<ImageAssetPort["resolve"]>>>;

export const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_IMAGE_CONTEXT_BYTES = 20 * 1024 * 1024;

export interface ImageInclusionDecision {
  blockId: string;
  included: boolean;
  decidedByCompaction?: true;
}

export interface CompactionImageProjectionMode {
  kind: "compaction";
  candidates: ReadonlySet<string>;
  decidingTurnId: TurnId;
}

export interface ImageContextProjection {
  blocks: Block[];
  decisions: ImageInclusionDecision[];
  breaks: ImageContextBreak[];
}

function reference(content: Block["content"]): PersistedImageReference | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  return content.type === "image_reference" &&
    typeof content.documentId === "string" &&
    typeof content.uri === "string"
    ? { type: "image_reference", documentId: content.documentId, uri: content.uri }
    : null;
}

/**
 * Project stable image decisions and named breaks; a compaction can fill free budget by
 * re-admitting excluded images without changing any existing inclusion.
 */
export async function projectImageBlocksForModel(input: {
  thread: Pick<Thread, "id" | "projectId" | "userId">;
  blocks: readonly Block[];
  inclusions?: ReadonlyMap<string, boolean>;
  supportsImageInput: boolean;
  imageAssets: ImageAssetPort;
  mode?: CompactionImageProjectionMode;
  signal?: AbortSignal;
}): Promise<ImageContextProjection> {
  input.signal?.throwIfAborted();
  const imageBlocks = input.blocks.filter((block) => block.blockType === "image");
  if (!input.supportsImageInput) {
    if (imageBlocks.length > 0) {
      input.imageAssets.diagnose?.({
        threadId: input.thread.id,
        projectId: input.thread.projectId,
        reason: "model_unsupported",
      });
    }
    return {
      blocks: input.blocks.filter((block) => block.blockType !== "image"),
      decisions: [],
      breaks: [],
    };
  }

  const reads = new Map<string, Awaited<ReturnType<ImageAssetPort["resolve"]>>>();
  const entries: Array<{
    index: number;
    block: Block;
    uri: string;
    image: ResolvedImage;
    included: boolean;
    reAdmissionCandidate: boolean;
  }> = [];
  const decisionById = new Map<string, ImageInclusionDecision>();
  const reAdmissionDecisionById = new Map<string, ImageInclusionDecision>();
  const breaks: ImageContextBreak[] = [];
  let diagnosedOmission = false;
  const unavailableReason = (included: boolean | undefined) =>
    included === true ? "asset_unavailable" : "asset_unavailable_first_sight";

  for (const [index, block] of input.blocks.entries()) {
    input.signal?.throwIfAborted();
    const includedDecision = input.inclusions?.get(block.id);
    const reAdmissionCandidate =
      input.mode?.kind === "compaction" &&
      includedDecision === false &&
      input.mode.candidates.has(block.id);
    if (block.blockType !== "image" || (includedDecision === false && !reAdmissionCandidate))
      continue;
    const identity = reference(block.content);
    if (!identity) {
      if (reAdmissionCandidate) continue;
      decisionById.set(block.id, { blockId: block.id, included: false });
      breaks.push({
        blockId: block.id,
        uri: block.id,
        reason: unavailableReason(includedDecision),
      });
      diagnosedOmission = true;
      continue;
    }

    const key = `${identity.documentId}\0${identity.uri}`;
    let image = reads.get(key);
    if (image === undefined) {
      try {
        image = await input.imageAssets.resolve(
          {
            threadId: input.thread.id,
            projectId: input.thread.projectId,
            actorUserId: input.thread.userId,
          },
          identity,
          { maxBytes: MAX_MODEL_IMAGE_BYTES },
        );
      } catch (error) {
        if (!reAdmissionCandidate || !(error instanceof ImageAssetResolutionError)) throw error;
        input.signal?.throwIfAborted();
        continue;
      }
      input.signal?.throwIfAborted();
      reads.set(key, image);
    }

    if (!image || !Number.isFinite(image.sizeBytes) || image.sizeBytes < 0) {
      if (reAdmissionCandidate) {
        if (image) throw new Error("Image asset resolver returned an invalid size");
        continue;
      }
      decisionById.set(block.id, { blockId: block.id, included: false });
      breaks.push({
        blockId: block.id,
        uri: identity.uri,
        reason: unavailableReason(includedDecision),
      });
      diagnosedOmission = true;
      continue;
    }
    const resolvedImage = image;

    entries.push({
      index,
      block,
      uri: identity.uri,
      image: resolvedImage,
      included: includedDecision === true,
      reAdmissionCandidate,
    });
  }

  // Previously included bytes own the current prefix. Only a newly carried image may evict them.
  let usedBytes = entries.reduce(
    (sum, entry) => sum + (entry.included ? entry.image.sizeBytes : 0),
    0,
  );
  for (const entry of entries) {
    if (entry.included && entry.image.sizeBytes > MAX_MODEL_IMAGE_BYTES) {
      entry.included = false;
      usedBytes -= entry.image.sizeBytes;
      decisionById.set(entry.block.id, { blockId: entry.block.id, included: false });
      breaks.push({ blockId: entry.block.id, uri: entry.uri, reason: "budget_eviction" });
    }
  }

  // A new late-arrival image retains the ordinary chronological eviction rule. A
  // re-admission candidate that did not fit is never allowed through this eviction path.
  for (const entry of entries) {
    if (entry.reAdmissionCandidate) continue;
    if (input.inclusions?.get(entry.block.id) !== true) {
      if (entry.image.sizeBytes > MAX_MODEL_IMAGE_BYTES) {
        decisionById.set(entry.block.id, { blockId: entry.block.id, included: false });
        diagnosedOmission = true;
        continue;
      }
      let canInclude = true;
      while (usedBytes + entry.image.sizeBytes > MAX_MODEL_IMAGE_CONTEXT_BYTES) {
        const oldest = entries.find(
          (candidate) =>
            candidate.included && !candidate.reAdmissionCandidate && candidate.index < entry.index,
        );
        if (!oldest) {
          decisionById.set(entry.block.id, { blockId: entry.block.id, included: false });
          diagnosedOmission = true;
          canInclude = false;
          break;
        }
        oldest.included = false;
        usedBytes -= oldest.image.sizeBytes;
        decisionById.set(oldest.block.id, { blockId: oldest.block.id, included: false });
        breaks.push({ blockId: oldest.block.id, uri: oldest.uri, reason: "budget_eviction" });
      }
      if (!canInclude) continue;
      entry.included = true;
      usedBytes += entry.image.sizeBytes;
      decisionById.set(entry.block.id, { blockId: entry.block.id, included: true });
    }
  }

  // Compaction candidates only claim budget left after normal late-arrival handling.
  for (const entry of entries
    .filter((candidate) => candidate.reAdmissionCandidate)
    .sort((left, right) => right.index - left.index)) {
    if (entry.image.sizeBytes > MAX_MODEL_IMAGE_BYTES) continue;
    if (usedBytes + entry.image.sizeBytes > MAX_MODEL_IMAGE_CONTEXT_BYTES) continue;
    entry.included = true;
    usedBytes += entry.image.sizeBytes;
    reAdmissionDecisionById.set(entry.block.id, {
      blockId: entry.block.id,
      included: true,
      decidedByCompaction: true,
    });
  }

  const projected = new Map<number, Block>();
  for (const entry of entries) {
    if (!entry.included) continue;
    projected.set(entry.index, {
      ...entry.block,
      content: {
        type: "image",
        mediaType: entry.image.mediaType,
        data: entry.image.data instanceof URL ? entry.image.data.href : entry.image.data,
      },
    });
  }

  if (diagnosedOmission) {
    input.imageAssets.diagnose?.({
      threadId: input.thread.id,
      projectId: input.thread.projectId,
      reason: "unavailable_or_over_budget",
    });
  }

  return {
    blocks: input.blocks.flatMap((block, index) => {
      if (block.blockType !== "image") return [block];
      const modelBlock = projected.get(index);
      return modelBlock ? [modelBlock] : [];
    }),
    decisions:
      input.mode?.kind === "compaction"
        ? [...reAdmissionDecisionById.values(), ...decisionById.values()]
        : [...decisionById.values()],
    breaks,
  };
}
