// Echo for post-merge apply results, and the lineage concurrent updates made visible.
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import type { BlockItemId } from "../model/block-hash.js";
import { splitHashline, toHashline } from "../model/hashline.js";
import type { AgentEditModel, ContentLineage } from "../ports/model.js";
import type { ApplyEchoHunk, ConcurrentUpdate } from "./types.js";

export interface BlockSnapshot {
  hash: string;
  clientID: number;
  clock: number;
  /** Hash-independent canonical rendering used by provenance classification. */
  renderedContent: string;
  /** Canonical hashless block body. */
  body: string;
  serialized: string;
  /** Visible prose ancestry; identities come from CRDT items, never text bytes. */
  lineage: readonly ContentLineage[];
}

/** Lineage concurrent updates first made visible, by the actor kind that wrote it. */
export interface ConcurrentDetectionResult {
  lineageOrigins: readonly (ContentLineage & { origin: "human" | "agent" })[];
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
  const blocks = model.getBlocks(doc);
  if (blocks.length === 0) return [];
  const hashes = model.getDocumentBlockIds(doc);
  const serialized = model.serializeBlockLines(doc, codec);
  const bodies = model.serializeBlockBodies(doc, codec, blocks);
  return blocks.map((block, index) => ({
    hash: hashes[index],
    ...model.getCanonicalBlockIdentity(block),
    renderedContent: `${model.getBlockType(block)}|${bodies[index]}`,
    body: bodies[index],
    serialized: serialized[index],
    lineage: model.getVisibleContentLineage(block),
  }));
}

/**
 * Apply concurrent updates one at a time, recording the lineage each first made visible and
 * who wrote it. Update bytes don't carry their origin, so callers pass it beside each one.
 */
export function applyConcurrentUpdates(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  updates: readonly ConcurrentUpdate[],
): ConcurrentDetectionResult {
  const lineageOrigins: Array<ContentLineage & { origin: "human" | "agent" }> = [];
  for (const item of updates) {
    if (item.update.length === 0) continue;
    if (item.origin.type === "system") {
      model.applyUpdate(doc, item.update, item.origin);
      continue;
    }
    const before = visibleLineage(snapshotBlocks(doc, model, codec));
    model.applyUpdate(doc, item.update, item.origin);
    const actor = item.origin.type === "agent" ? "agent" : "human";
    for (const lineage of visibleLineage(snapshotBlocks(doc, model, codec)))
      if (!lineageCovered(lineage, before)) lineageOrigins.push({ ...lineage, origin: actor });
  }
  return { lineageOrigins };
}

function visibleLineage(blocks: readonly BlockSnapshot[]): ContentLineage[] {
  return blocks.flatMap((block) => block.lineage);
}

function lineageCovered(target: ContentLineage, candidates: readonly ContentLineage[]): boolean {
  const end = target.clock + target.length;
  let coveredUntil = target.clock;
  const relevant = candidates
    .filter(
      (candidate) =>
        candidate.clientID === target.clientID &&
        candidate.clock < end &&
        candidate.clock + candidate.length > target.clock,
    )
    .sort((left, right) => left.clock - right.clock);
  for (const candidate of relevant) {
    if (candidate.clock > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, candidate.clock + candidate.length);
    if (coveredUntil >= end) return true;
  }
  return false;
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
 * to the document, merged, in order. The echo's window, and the region a write is checked in.
 * A target of -1 (an insert at the start) widens to the first block.
 */
export function windowOf(targets: Iterable<number>, blockCount: number): number[] {
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
