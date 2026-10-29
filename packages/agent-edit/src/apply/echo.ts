// Block snapshots, and the echo a write shows of what it changed.
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import type { BlockItemId } from "../model/block-hash.js";
import { splitHashline, toHashline } from "../model/hashline.js";
import type { AgentEditModel, ProjectedBlock } from "../ports/model.js";
import type { ApplyEchoHunk } from "./types.js";

export interface BlockSnapshot {
  hash: string;
  clientID: number;
  clock: number;
  /** Canonical hashless block body. */
  body: string;
  serialized: string;
}

export interface EchoInput {
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
  agentTouchedBlocks: readonly BlockItemId[];
  agentDeletedBlocks: readonly BlockItemId[];
}

/** Capture the agent-visible block lines used by echo and concurrent diffing. */
export function snapshotBlocks(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
): BlockSnapshot[] {
  return snapshotProjected(model.projectBlocks(doc), codec);
}

/** `snapshotBlocks` over a projection the caller already holds. */
export function snapshotProjected(
  projected: readonly ProjectedBlock[],
  codec: AgentEditCodec,
): BlockSnapshot[] {
  const bodies = codec.serializeBlocks(
    projected.map((block) => block.node),
    projected.map((block) => block.hash),
  );
  return projected.map(({ id, hash }, index) => ({
    hash,
    ...id,
    body: bodies[index],
    serialized: toHashline(hash, bodies[index]),
  }));
}

/** Build adaptive echo hunks from the post-merge document snapshot. */
export function computeEcho(input: EchoInput): ApplyEchoHunk[] {
  const echoIndexes = uniqueEchoIndexes(input);
  if (echoIndexes.length === 0) return [];

  const beforeById = new Map(input.before.map((block) => [blockIdentity(block), block]));
  const hunks = echoIndexes.flatMap((index): ApplyEchoHunk[] => {
    const block = input.after[index];
    if (!block) return [];
    const previous = beforeById.get(blockIdentity(block));
    const mode = !previous || previous.body !== block.body ? "full" : "truncated";
    return [
      {
        mode,
        blocks: [mode === "full" ? block.serialized : truncateSerializedBlock(block.serialized)],
      },
    ];
  });
  return mergeEchoHunks(hunks);
}

/**
 * The blocks around `targets`: each target index widened by one neighbour on each side, clamped
 * to the document, merged, in order. The echo's window.
 * A target of -1 (an insert at the start) widens to the first block.
 */
function windowOf(targets: Iterable<number>, blockCount: number): number[] {
  const indexes = new Set<number>();
  for (const target of targets) {
    for (
      let index = Math.max(0, target - 1);
      index <= Math.min(blockCount - 1, target + 1);
      index += 1
    )
      indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function uniqueEchoIndexes(input: EchoInput): number[] {
  const afterIndex = new Map(input.after.map((block, index) => [blockIdentity(block), index]));
  const beforeIndex = new Map(input.before.map((block, index) => [blockIdentity(block), index]));
  const candidateIndexes = new Set<number>();

  for (const block of input.agentTouchedBlocks) {
    const index = afterIndex.get(blockIdentity(block));
    if (index !== undefined) candidateIndexes.add(index);
  }
  for (const block of input.agentDeletedBlocks) {
    const deletedIndex = beforeIndex.get(blockIdentity(block));
    if (deletedIndex === undefined) continue;
    for (const index of adjacentSurvivorIndexes(input.before, afterIndex, deletedIndex)) {
      candidateIndexes.add(index);
    }
  }
  return windowOf(candidateIndexes, input.after.length);
}

function adjacentSurvivorIndexes(
  before: readonly BlockSnapshot[],
  afterIndex: ReadonlyMap<string, number>,
  deletedIndex: number,
): number[] {
  const indexes: number[] = [];
  for (let index = deletedIndex - 1; index >= 0; index -= 1) {
    const survivor = afterIndex.get(blockIdentity(before[index]));
    if (survivor !== undefined) {
      indexes.push(survivor);
      break;
    }
  }
  for (let index = deletedIndex + 1; index < before.length; index += 1) {
    const survivor = afterIndex.get(blockIdentity(before[index]));
    if (survivor !== undefined) {
      indexes.push(survivor);
      break;
    }
  }
  return indexes;
}

function mergeEchoHunks(hunks: ApplyEchoHunk[]): ApplyEchoHunk[] {
  const merged: ApplyEchoHunk[] = [];
  for (const hunk of hunks) {
    const last = merged.at(-1);
    if (!last || last.mode !== hunk.mode) {
      merged.push({ mode: hunk.mode, blocks: [...hunk.blocks] });
      continue;
    }
    const existing = new Set(last.blocks.map(blockHash));
    for (const block of hunk.blocks) {
      const hash = blockHash(block);
      if (existing.has(hash)) continue;
      last.blocks.push(block);
      existing.add(hash);
    }
  }
  return merged;
}

function blockHash(serialized: string): string {
  return splitHashline(serialized)?.hash ?? serialized;
}

export function truncateSerializedBlock(serialized: string): string {
  const line = splitHashline(serialized);
  if (!line) return truncateWords(serialized);
  return toHashline(line.hash, truncateWords(line.body.replace(/^\n/, "")));
}

function truncateWords(text: string, maxWords = 8): string {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= maxWords) return text;
  const lastWord = words[maxWords - 1];
  const end = (lastWord?.index ?? 0) + (lastWord?.[0].length ?? 0);
  return text.slice(0, end);
}

function blockIdentity(block: BlockItemId): string {
  return `${block.clientID}:${block.clock}`;
}
