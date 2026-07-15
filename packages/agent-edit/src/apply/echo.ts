// Echo and concurrent-edit reporting for post-merge apply results.
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type {
  ApplyEchoHunk,
  ConcurrentEditInfo,
  ConcurrentEditRun,
  ConcurrentUpdateOrigin,
} from "./types.js";

export interface BlockSnapshot {
  hash: string;
  clientID?: number;
  clock?: number;
  /** Hash-independent canonical rendering used by observation snapshots. */
  renderedContent?: string;
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
  touchedHashes?: {
    human?: readonly string[];
    agent?: readonly string[];
  };
  /** Baseline block hashes explicitly deleted by the attribution kernel. */
  deletedHashes?: {
    human?: readonly string[];
    agent?: readonly string[];
  };
}

export interface ConcurrentDetectionResult {
  info?: ConcurrentEditInfo;
  /** Human-origin hashes used by destructive-write safety checks. */
  humanTouchedHashes: Set<string>;
  /** Human + agent hashes used by concurrent-edit reporting. */
  touchedHashes: Set<string>;
}

export interface EchoInput {
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
  agentTouchedHashes: ReadonlySet<string>;
  agentDeletedHashes: ReadonlySet<string>;
}

/** Nearby concurrent hunks are joined so the prose between them is visible too. */
export const DEFAULT_CONCURRENT_RUN_GAP = 2;

/** At rewrite scale sparse windows stop helping; render the current document once. */
export const CONCURRENT_REWRITE_DENSITY = 0.6;

type DeletedBody = {
  block: BlockSnapshot;
  origin: "human" | "agent";
  leftHash?: string;
  rightHash?: string;
};

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
 * Concurrent attribution cares about semantic block movement across a re-sync,
 * not the transient block hashes produced by whole-document rewrites. Match
 * unchanged block bodies in order, then report only the unmatched gap: pure
 * before gaps are deletes, pure after gaps are inserts, and replacement gaps are
 * the surviving after hashes.
 */
function diffConcurrentSnapshots(
  before: readonly BlockSnapshot[],
  after: readonly BlockSnapshot[],
): SnapshotChangeSet {
  const direct = diffSnapshots(before, after);
  if (direct.deleted.size === 0 && direct.inserted.size === 0) return direct;

  const matches = bodyLcs(before, after);
  const changed = new Set(direct.changed);
  const deleted = new Set<string>();
  const inserted = new Set<string>();
  let beforeStart = 0;
  let afterStart = 0;

  for (const match of [...matches, { beforeIndex: before.length, afterIndex: after.length }]) {
    addConcurrentGap({
      before: before.slice(beforeStart, match.beforeIndex),
      after: after.slice(afterStart, match.afterIndex),
      deleted,
      inserted,
      changed,
    });
    beforeStart = match.beforeIndex + 1;
    afterStart = match.afterIndex + 1;
  }

  return { changed, deleted, inserted };
}

function addConcurrentGap(input: {
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
  deleted: Set<string>;
  inserted: Set<string>;
  changed: Set<string>;
}): void {
  if (input.before.length === 0) {
    for (const block of input.after) input.inserted.add(block.hash);
    return;
  }
  if (input.after.length === 0) {
    for (const block of input.before) input.deleted.add(block.hash);
    return;
  }
  for (const block of input.before) input.deleted.add(block.hash);
  for (const block of input.after) input.changed.add(block.hash);
}

function bodyLcs(
  before: readonly BlockSnapshot[],
  after: readonly BlockSnapshot[],
): Array<{ beforeIndex: number; afterIndex: number }> {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const matchScore = blockMatchScore(before[i], after[j]);
      table[i][j] =
        matchScore > 0
          ? Math.max(table[i + 1][j + 1] + matchScore, table[i + 1][j], table[i][j + 1])
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const matches: Array<{ beforeIndex: number; afterIndex: number }> = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const matchScore = blockMatchScore(before[i], after[j]);
    const matchValue = matchScore > 0 ? table[i + 1][j + 1] + matchScore : -1;
    if (
      matchScore > 0 &&
      matchValue >= table[i + 1][j] &&
      matchValue >= table[i][j + 1] &&
      table[i][j] === matchValue
    ) {
      matches.push({ beforeIndex: i, afterIndex: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

function blockMatchScore(
  before: BlockSnapshot | undefined,
  after: BlockSnapshot | undefined,
): number {
  if (!before || !after) return 0;
  if (blockBody(before.serialized) !== blockBody(after.serialized)) return 0;
  return before.hash === after.hash ? 2 : 1;
}

function blockBody(serialized: string): string {
  const separator = serialized.indexOf("|");
  return separator < 0 ? serialized : serialized.slice(separator + 1);
}

/** Return stable top-level block hashes whose content or presence differs between two docs. */
export function touchedBlockHashesBetween(input: {
  before: DocHandle;
  after: DocHandle;
  model: AgentEditModel;
  codec: AgentEditCodec;
}): Set<string> {
  const diff = diffSnapshots(
    snapshotBlocks(input.before, input.model, input.codec),
    snapshotBlocks(input.after, input.model, input.codec),
  );
  return new Set([...diff.changed, ...diff.deleted, ...diff.inserted]);
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
  ownOrigin?: ConcurrentUpdateOrigin,
  runGap = DEFAULT_CONCURRENT_RUN_GAP,
): ConcurrentDetectionResult {
  const byActor = { human: new Set<string>(), agent: new Set<string>() };
  const deletedBodies = new Map<string, DeletedBody>();

  for (const item of updates) {
    if (isOwnUpdate(item.origin, ownOrigin)) continue;
    const before = snapshotBlocks(doc, model, codec);
    if (item.touchedHashes || item.deletedHashes) {
      if (item.update.length > 0) model.applyUpdate(doc, item.update, item.origin);
      for (const hash of item.touchedHashes?.human ?? []) byActor.human.add(hash);
      for (const hash of item.touchedHashes?.agent ?? []) byActor.agent.add(hash);
      for (const hash of item.deletedHashes?.human ?? []) byActor.human.add(hash);
      for (const hash of item.deletedHashes?.agent ?? []) byActor.agent.add(hash);
      captureDeletedBodies(before, item.deletedHashes?.human, "human", deletedBodies);
      captureDeletedBodies(before, item.deletedHashes?.agent, "agent", deletedBodies);
      continue;
    }

    model.applyUpdate(doc, item.update, item.origin);
    const after = snapshotBlocks(doc, model, codec);
    const diff = diffConcurrentSnapshots(before, after);
    const touched = new Set([...diff.changed, ...diff.deleted, ...diff.inserted]);
    if (touched.size === 0) continue;

    const buckets = bucketsForOrigin(item.origin, byActor);
    for (const bucket of buckets) {
      for (const hash of touched) bucket.add(hash);
    }
    const deletedOrigin = item.origin.type === "agent" ? "agent" : "human";
    captureDeletedBodies(before, diff.deleted, deletedOrigin, deletedBodies);
  }

  const human = orderedHashes(model, doc, byActor.human);
  const agent = orderedHashes(model, doc, byActor.agent);
  const humanTouchedHashes = new Set(human);
  const touchedHashes = new Set([...human, ...agent]);
  if (touchedHashes.size === 0) return { humanTouchedHashes, touchedHashes };
  const runs = renderConcurrentRuns({
    after: snapshotBlocks(doc, model, codec),
    human: humanTouchedHashes,
    agent: new Set(agent),
    deletedBodies,
    gap: runGap,
  });
  return { info: { human, agent, runs }, humanTouchedHashes, touchedHashes };
}

function captureDeletedBodies(
  before: readonly BlockSnapshot[],
  hashes: Iterable<string> | undefined,
  origin: "human" | "agent",
  target: Map<string, DeletedBody>,
): void {
  if (!hashes) return;
  const byHash = new Map(before.map((block) => [block.hash, block]));
  for (const hash of hashes) {
    const block = byHash.get(hash);
    const index = before.findIndex((candidate) => candidate.hash === hash);
    if (block) {
      target.set(hash, {
        block,
        origin,
        ...(before[index - 1] ? { leftHash: before[index - 1].hash } : {}),
        ...(before[index + 1] ? { rightHash: before[index + 1].hash } : {}),
      });
    }
  }
}

export function renderConcurrentRuns(input: {
  after: readonly BlockSnapshot[];
  human: ReadonlySet<string>;
  agent: ReadonlySet<string>;
  deletedBodies?: ReadonlyMap<string, DeletedBody>;
  gap?: number;
}): ConcurrentEditRun[] {
  const gap = input.gap ?? DEFAULT_CONCURRENT_RUN_GAP;
  const changedIndexes = input.after.flatMap((block, index) =>
    input.human.has(block.hash) || input.agent.has(block.hash) ? [index] : [],
  );
  const intervals = mergeChangedIntervals(changedIndexes, gap);
  const changedCount = new Set(changedIndexes).size;
  const rewrite =
    input.after.length > 0 && changedCount / input.after.length >= CONCURRENT_REWRITE_DENSITY;
  const windows = rewrite
    ? [{ start: 0, end: input.after.length - 1 }]
    : intervals.map(({ start, end }) => ({
        start: Math.max(0, start - 1),
        end: Math.min(input.after.length - 1, end + 1),
      }));
  const afterIndex = new Map(input.after.map((block, index) => [block.hash, index]));
  for (const deleted of input.deletedBodies?.values() ?? []) {
    const left = deleted.leftHash ? afterIndex.get(deleted.leftHash) : undefined;
    const right = deleted.rightHash ? afterIndex.get(deleted.rightHash) : undefined;
    if (left !== undefined || right !== undefined) {
      windows.push({ start: left ?? right ?? 0, end: right ?? left ?? 0 });
    }
  }
  windows.sort((left, right) => left.start - right.start);
  const mergedWindows = mergeWindowsUntilStable(windows, gap);
  const runs: ConcurrentEditRun[] = mergedWindows.map(({ start, end }) => {
    const blocks = input.after.slice(start, end + 1);
    return {
      origin: originForHashes(
        blocks.map((block) => block.hash),
        input.human,
        input.agent,
      ),
      blocks: blocks.map((block) => block.serialized),
      tombstones: [],
      observations: blocks.flatMap((block) =>
        block.clientID !== undefined && block.clock !== undefined && block.renderedContent
          ? [
              {
                kind: "rendered" as const,
                clientID: block.clientID,
                clock: block.clock,
                renderedContent: block.renderedContent,
              },
            ]
          : [],
      ),
    } satisfies ConcurrentEditRun;
  });

  for (const [hash, deleted] of input.deletedBodies ?? []) {
    const body = blockBody(deleted.block.serialized).replace(/^\n/, "");
    const target: ConcurrentEditRun = runs.at(-1) ?? {
      origin: deleted.origin,
      blocks: [],
      tombstones: [],
      observations: [],
    };
    if (runs.length === 0) runs.push(target);
    target.tombstones.push({ hash, capturedBody: body });
    if (deleted.block.clientID !== undefined && deleted.block.clock !== undefined) {
      target.observations.push({
        kind: "explicit_deletion",
        clientID: deleted.block.clientID,
        clock: deleted.block.clock,
        capturedBody: body,
      });
    }
    target.origin = mergeOrigin(target.origin, deleted.origin);
  }
  return runs;
}

function mergeChangedIntervals(indexes: readonly number[], gap: number) {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const index of indexes) {
    const last = intervals.at(-1);
    if (last && index - last.end - 1 <= gap) last.end = index;
    else intervals.push({ start: index, end: index });
  }
  return intervals;
}

function mergeWindowsUntilStable(
  source: Array<{ start: number; end: number }>,
  gap: number,
): Array<{ start: number; end: number }> {
  let windows = source;
  while (true) {
    const merged: Array<{ start: number; end: number }> = [];
    for (const window of windows) {
      const last = merged.at(-1);
      if (last && window.start - last.end - 1 <= gap) last.end = Math.max(last.end, window.end);
      else merged.push({ ...window });
    }
    if (merged.length === windows.length) return merged;
    windows = merged;
  }
}

function originForHashes(
  hashes: readonly string[],
  human: ReadonlySet<string>,
  agent: ReadonlySet<string>,
): ConcurrentEditRun["origin"] {
  const hasHuman = hashes.some((hash) => human.has(hash));
  const hasAgent = hashes.some((hash) => agent.has(hash));
  return hasHuman && hasAgent
    ? "mixed"
    : hasHuman
      ? "human"
      : hasAgent
        ? "agent"
        : "concurrent edits";
}

function mergeOrigin(
  left: ConcurrentEditRun["origin"],
  right: "human" | "agent",
): ConcurrentEditRun["origin"] {
  if (left === "concurrent edits" || left === right) return right;
  return "mixed";
}

function bucketsForOrigin(
  origin: ConcurrentUpdateOrigin,
  byActor: { human: Set<string>; agent: Set<string> },
): Set<string>[] {
  return [origin.type === "agent" ? byActor.agent : byActor.human];
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

function isOwnUpdate(
  origin: ConcurrentUpdateOrigin,
  ownOrigin: ConcurrentUpdateOrigin | undefined,
): boolean {
  if (origin.type === "agent" && ownOrigin?.type === "agent") {
    return origin.actorTurnId === ownOrigin.actorTurnId;
  }
  return (
    origin.type === "human" && ownOrigin?.type === "human" && origin.userId === ownOrigin.userId
  );
}
