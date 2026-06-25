// Echo and concurrent-edit reporting for post-merge apply results.
import * as Y from "yjs";

import type { Codec } from "../codec/types.js";
import { projectDocumentBlocks } from "../model/block-projection.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ApplyEchoHunk, ConcurrentEditInfo, ConcurrentUpdateOrigin } from "./types.js";

export interface BlockSnapshot {
  hash: string;
  serialized: string;
}

export interface SnapshotChangeSet {
  changed: Set<string>;
  deleted: Set<string>;
  inserted: Set<string>;
}

export interface ConcurrentUpdateInput {
  update: Uint8Array;
  origin: ConcurrentUpdateOrigin;
}

export interface ConcurrentDetectionResult {
  info?: ConcurrentEditInfo;
  touchedHashes: Set<string>;
}

export interface EchoInput {
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
  agentTouchedHashes: ReadonlySet<string>;
  agentDeletedHashes: ReadonlySet<string>;
  structuralChange: boolean;
  concurrentTouchedHashes: ReadonlySet<string>;
}

const DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD = 5;
const TRUNCATED_PREVIEW_LENGTH = 48;

/** Capture the agent-visible block lines used by echo and concurrent diffing. */
export function snapshotBlocks(doc: Y.Doc, model: AgentEditModel, codec: Codec): BlockSnapshot[] {
  const projection = projectDocumentBlocks(doc, model);
  if (projection.blocks.length === 0) return [];
  const serialized = codec.serializeBlocks(projection.pmBlocks, projection.hashes);
  return projection.blocks.map((_, index) => ({
    hash: projection.hashes[index],
    serialized: serialized[index],
  }));
}

/** Diff two block snapshots by stable block hash and serialized content. */
export function diffSnapshots(
  before: readonly BlockSnapshot[],
  after: readonly BlockSnapshot[],
): SnapshotChangeSet {
  const beforeByHash = new Map(before.map((block) => [block.hash, block]));
  const afterByHash = new Map(after.map((block) => [block.hash, block]));
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const inserted = new Set<string>();

  for (const block of before) {
    const next = afterByHash.get(block.hash);
    if (!next) {
      deleted.add(block.hash);
      continue;
    }
    if (next.serialized !== block.serialized) changed.add(block.hash);
  }
  for (const block of after) {
    if (!beforeByHash.has(block.hash)) inserted.add(block.hash);
  }
  return { changed, deleted, inserted };
}

/**
 * Apply re-sync updates one at a time so their changed blocks can be attributed
 * to their persisted origin metadata. Update bytes themselves do not carry that
 * origin, so callers pass the journal/live-sync origin beside each update.
 */
export function applyConcurrentUpdates(
  doc: Y.Doc,
  model: AgentEditModel,
  codec: Codec,
  updates: readonly ConcurrentUpdateInput[],
  ownOrigin?: { type: "agent"; actorTurnId: string },
  syncStateVector: Uint8Array = Y.encodeStateVector(doc),
  collapseThreshold = DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD,
): ConcurrentDetectionResult {
  const byActor = { human: new Set<string>(), agent: new Set<string>() };

  for (const item of updates) {
    if (isOwnAgentUpdate(item.origin, ownOrigin)) continue;
    const before = snapshotBlocks(doc, model, codec);
    Y.applyUpdate(doc, item.update, item.origin);
    if (!stateVectorAdvanced(syncStateVector, Y.encodeStateVector(doc))) continue;
    const after = snapshotBlocks(doc, model, codec);
    const diff = diffSnapshots(before, after);
    const touched = new Set([...diff.changed, ...diff.deleted, ...diff.inserted]);
    const bucket = item.origin.type === "agent" ? byActor.agent : byActor.human;
    for (const hash of touched) bucket.add(hash);
  }

  const human = orderedHashes(model, doc, byActor.human);
  const agent = orderedHashes(model, doc, byActor.agent);
  const touchedHashes = new Set([...human, ...agent]);
  const total = human.length + agent.length;
  if (total === 0) return { touchedHashes };
  if (total > collapseThreshold) {
    const collapsed: ConcurrentEditInfo = {
      human: human.length > 0 ? ["*"] : [],
      agent: agent.length > 0 ? ["*"] : [],
      collapsed: true,
      reviewCommand: 'write(command="view", file="<current>")',
    };
    return { info: collapsed, touchedHashes };
  }
  return { info: { human, agent }, touchedHashes };
}

/** Build adaptive echo hunks from the post-merge document snapshot. */
export function computeEcho(input: EchoInput): ApplyEchoHunk[] {
  const changedWindows = changedBlockWindows(input);
  if (changedWindows.length === 0) return [];

  const hunks = changedWindows.flatMap((window): ApplyEchoHunk[] => {
    const hasConcurrentOverlap = window.some((index) =>
      input.concurrentTouchedHashes.has(input.after[index]?.hash ?? ""),
    );
    const mode = hasConcurrentOverlap
      ? "full"
      : structuralChangeInWindow(input, window)
        ? "truncated"
        : undefined;
    if (!mode) return [];
    return [
      {
        mode,
        blocks: window.map((index) =>
          mode === "full"
            ? (input.after[index]?.serialized ?? "")
            : truncateSerializedBlock(input.after[index]?.serialized ?? ""),
        ),
      },
    ];
  });
  return mergeEchoHunks(hunks);
}

function structuralChangeInWindow(input: EchoInput, window: readonly number[]): boolean {
  if (!input.structuralChange) return false;

  const beforeHashes = new Set(input.before.map((block) => block.hash));
  const insertedInWindow = window.some(
    (index) => !beforeHashes.has(input.after[index]?.hash ?? ""),
  );
  if (insertedInWindow) return true;

  const afterIndex = new Map(input.after.map((block, index) => [block.hash, index]));
  for (const hash of input.agentDeletedHashes) {
    const deletedIndex = input.before.findIndex((block) => block.hash === hash);
    if (deletedIndex < 0) continue;
    const survivorIndexes = adjacentSurvivorIndexes(input.before, afterIndex, deletedIndex);
    if (survivorIndexes.some((index) => window.includes(index))) return true;
  }

  const hasKnownStructuralHashes =
    input.agentDeletedHashes.size > 0 || input.after.some((block) => !beforeHashes.has(block.hash));
  return !hasKnownStructuralHashes;
}

function changedBlockWindows(input: EchoInput): number[][] {
  const afterIndex = new Map(input.after.map((block, index) => [block.hash, index]));
  const beforeIndex = new Map(input.before.map((block, index) => [block.hash, index]));
  const candidateIndexes = new Set<number>();

  for (const hash of input.agentTouchedHashes) {
    const index = afterIndex.get(hash);
    if (index !== undefined) candidateIndexes.add(index);
  }
  for (const hash of input.agentDeletedHashes) {
    const deletedIndex = beforeIndex.get(hash);
    if (deletedIndex === undefined) continue;
    for (const index of adjacentSurvivorIndexes(input.before, afterIndex, deletedIndex)) {
      candidateIndexes.add(index);
    }
  }

  const windows = [...candidateIndexes]
    .sort((left, right) => left - right)
    .map((index) => expandWindow(index, input.after.length));
  return windows;
}

function adjacentSurvivorIndexes(
  before: readonly BlockSnapshot[],
  afterIndex: ReadonlyMap<string, number>,
  deletedIndex: number,
): number[] {
  const indexes: number[] = [];
  for (let index = deletedIndex - 1; index >= 0; index -= 1) {
    const survivor = afterIndex.get(before[index]?.hash ?? "");
    if (survivor !== undefined) {
      indexes.push(survivor);
      break;
    }
  }
  for (let index = deletedIndex + 1; index < before.length; index += 1) {
    const survivor = afterIndex.get(before[index]?.hash ?? "");
    if (survivor !== undefined) {
      indexes.push(survivor);
      break;
    }
  }
  return indexes;
}

function expandWindow(index: number, blockCount: number): number[] {
  const start = Math.max(0, index - 1);
  const end = Math.min(blockCount - 1, index + 1);
  const indexes: number[] = [];
  for (let current = start; current <= end; current += 1) indexes.push(current);
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
  const separator = serialized.indexOf("|");
  return separator < 0 ? serialized : serialized.slice(0, separator);
}

export function truncateSerializedBlock(serialized: string): string {
  const separator = serialized.indexOf("|");
  if (separator < 0) return truncateText(serialized);
  const hash = serialized.slice(0, separator);
  const body = serialized
    .slice(separator + 1)
    .replace(/^\n/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${hash}|${truncateText(body)}`;
}

function truncateText(text: string): string {
  if (text.length <= TRUNCATED_PREVIEW_LENGTH) return text;
  return `${text.slice(0, TRUNCATED_PREVIEW_LENGTH - 3)}...`;
}

function stateVectorAdvanced(beforeVector: Uint8Array, afterVector: Uint8Array): boolean {
  const before = Y.decodeStateVector(beforeVector);
  const after = Y.decodeStateVector(afterVector);
  for (const [client, clock] of after) {
    if (clock > (before.get(client) ?? 0)) return true;
  }
  return false;
}

function orderedHashes(model: AgentEditModel, doc: Y.Doc, hashes: ReadonlySet<string>): string[] {
  const liveOrder = model.getDocumentBlockIds(doc);
  const live = liveOrder.filter((hash) => hashes.has(hash));
  const deleted = [...hashes].filter((hash) => !liveOrder.includes(hash)).sort();
  return [...live, ...deleted];
}

function isOwnAgentUpdate(
  origin: ConcurrentUpdateOrigin,
  ownOrigin: { type: "agent"; actorTurnId: string } | undefined,
): boolean {
  return (
    origin.type === "agent" &&
    ownOrigin?.type === "agent" &&
    origin.actorTurnId === ownOrigin.actorTurnId
  );
}
