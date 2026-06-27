// Echo and concurrent-edit reporting for post-merge apply results.
import * as Y from "yjs";

import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import { unwrapDoc } from "../handles.js";
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
}

const DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD = 5;

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
  return blocks.map((_, index) => ({
    hash: hashes[index],
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
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  updates: readonly ConcurrentUpdateInput[],
  ownOrigin?: { type: "agent"; actorTurnId: string },
  syncStateVector: Uint8Array = Y.encodeStateVector(unwrapDoc(doc)),
  collapseThreshold = DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD,
): ConcurrentDetectionResult {
  const byActor = { human: new Set<string>(), agent: new Set<string>() };

  for (const item of updates) {
    if (isOwnAgentUpdate(item.origin, ownOrigin)) continue;
    const before = snapshotBlocks(doc, model, codec);
    Y.applyUpdate(unwrapDoc(doc), item.update, item.origin);
    if (!stateVectorAdvanced(syncStateVector, Y.encodeStateVector(unwrapDoc(doc)))) continue;
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
      reviewCommand: 'write(command="read", file="<current>")',
    };
    return { info: collapsed, touchedHashes };
  }
  return { info: { human, agent }, touchedHashes };
}

/** Build adaptive echo hunks from the post-merge document snapshot. */
export function computeEcho(input: EchoInput): ApplyEchoHunk[] {
  const echoIndexes = uniqueEchoIndexes(input);
  if (echoIndexes.length === 0) return [];

  const beforeByHash = new Map(input.before.map((block) => [block.hash, block]));
  const hunks = echoIndexes.flatMap((index): ApplyEchoHunk[] => {
    const block = input.after[index];
    if (!block) return [];
    const previous = beforeByHash.get(block.hash);
    const mode = !previous || previous.serialized !== block.serialized ? "full" : "truncated";
    return [
      {
        mode,
        blocks: [mode === "full" ? block.serialized : truncateSerializedBlock(block.serialized)],
      },
    ];
  });
  return mergeEchoHunks(hunks);
}

function uniqueEchoIndexes(input: EchoInput): number[] {
  const indexes = new Set<number>();
  for (const window of changedBlockWindows(input)) {
    for (const index of window) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
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
  if (separator < 0) return truncateWords(serialized);
  const hash = serialized.slice(0, separator);
  const body = serialized
    .slice(separator + 1)
    .replace(/^\n/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${hash}|${truncateWords(body)}`;
}

function truncateWords(text: string, maxWords = 8): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function stateVectorAdvanced(beforeVector: Uint8Array, afterVector: Uint8Array): boolean {
  const before = Y.decodeStateVector(beforeVector);
  const after = Y.decodeStateVector(afterVector);
  for (const [client, clock] of after) {
    if (clock > (before.get(client) ?? 0)) return true;
  }
  return false;
}

function orderedHashes(
  model: AgentEditModel,
  doc: DocHandle,
  hashes: ReadonlySet<string>,
): string[] {
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
