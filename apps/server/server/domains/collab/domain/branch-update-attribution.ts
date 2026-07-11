/** Neutral block-coverage attribution shared by agent editing and branch push planning. */
import {
  type AgentEditCodec,
  type BlockSnapshot,
  DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD,
  snapshotBlocks,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import * as Y from "yjs";

type BlockCoverage = { origin: "agent" | "writer"; actorTurnId?: string };

type PartitionByBlockCoverageInput = {
  baselineState: Uint8Array | null;
  upstreamState: Uint8Array;
  rows: Array<{
    id: number;
    source: "agent" | "writer";
    actorTurnId?: string | null;
    update: Uint8Array;
  }>;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  collapseThreshold?: number;
};

export type ConcurrentBlockCoverageRow = PartitionByBlockCoverageInput["rows"][number];

/**
 * Attribute block changes between two snapshots to human journal rows.
 * Branch push uses the same kernel as agent-edit so destructive-write gates
 * cannot drift on origin classification or residual Yjs changes.
 */
export function humanTouchedHashesByBlockCoverage(input: {
  baselineState: Uint8Array;
  upstreamState: Uint8Array;
  rows: ConcurrentBlockCoverageRow[];
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): Set<string> {
  const coverage = partitionByBlockCoverage(input);
  const touched = new Set(coverage.humanResidualHashes);
  for (const [hash, owner] of coverage.coverage) {
    if (owner.origin === "writer") touched.add(hash);
  }
  for (const [hash, owner] of coverage.deletedCoverage) {
    if (owner.origin === "writer") touched.add(hash);
  }
  for (const hash of coverage.humanDeletedHashes) touched.add(hash);
  return touched;
}

export function partitionByBlockCoverage(inputs: PartitionByBlockCoverageInput): {
  coverage: Map<string, BlockCoverage>;
  humanResidualHashes: Set<string>;
  deletedCoverage: Map<string, BlockCoverage>;
  humanDeletedHashes: Set<string>;
  collapsed: boolean;
} {
  const finalDoc = docFromState(inputs.upstreamState);
  const scratch = docFromState(inputs.baselineState);
  try {
    const finalBlocks = blocks(finalDoc, inputs.model, inputs.codec);
    const finalByBody = multimap(finalBlocks, blockBody);
    const baselineBlocks = blocks(scratch, inputs.model, inputs.codec);
    const baselineBodies = counted(baselineBlocks.map(blockBody));
    const baselineHistoricalText = historicalText(inputs.baselineState);
    const coverage = new Map<string, BlockCoverage>();
    const deletedCoverage = new Map<string, BlockCoverage>();
    for (const row of inputs.rows) {
      const beforeBlocks = blocks(scratch, inputs.model, inputs.codec);
      const beforeCounts = counted(beforeBlocks.map(blockBody));
      Y.applyUpdate(scratch, row.update);
      const afterBlocks = blocks(scratch, inputs.model, inputs.codec);
      const afterCounts = counted(afterBlocks.map(blockBody));
      const rowHashes = new Set<string>();
      claimDeletedBodies(
        beforeCounts,
        afterCounts,
        beforeBlocks,
        afterBlocks,
        deletedCoverage,
        row,
      );
      for (const block of afterBlocks) {
        const body = blockBody(block);
        const introduced = (afterCounts.get(body) ?? 0) - (beforeCounts.get(body) ?? 0);
        if (introduced <= 0) continue;
        const already = [...rowHashes].filter((hash) => {
          const finalBlock = finalBlocks.find((candidate) => candidate.hash === hash);
          return finalBlock ? blockBody(finalBlock) === body : false;
        }).length;
        if (already >= introduced) continue;
        claimOneByBody(finalByBody, body, coverage, rowHashes, row);
      }
      for (const needle of insertedNeedles(row.update, beforeCounts)) {
        for (const block of finalBlocks) {
          if (rowHashes.has(block.hash)) continue;
          const body = blockBody(block);
          if ((baselineBodies.get(body) ?? 0) > 0) continue;
          if (!body.includes(needle)) continue;
          claimHash(block.hash, coverage, rowHashes, row);
        }
      }
    }
    const humanDeleted = humanDeletedHashes(baselineBlocks, finalBlocks, deletedCoverage);
    const residual = new Set<string>();
    const consumedBaseline = new Map<string, number>();
    for (const block of finalBlocks) {
      if (coverage.has(block.hash)) continue;
      const body = blockBody(block);
      const used = consumedBaseline.get(body) ?? 0;
      const base = baselineBodies.get(body) ?? 0;
      if (used < base) {
        consumedBaseline.set(body, used + 1);
        continue;
      }
      if (baselineHistoricalText.includes(body)) continue;
      residual.add(block.hash);
    }
    const visibleCoverage = coverage.size + deletedCoverage.size;
    return {
      coverage,
      humanResidualHashes: residual,
      deletedCoverage,
      humanDeletedHashes: humanDeleted,
      collapsed:
        visibleCoverage + residual.size + humanDeleted.size >
        (inputs.collapseThreshold ?? DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD),
    };
  } finally {
    finalDoc.destroy();
    scratch.destroy();
  }
}

function claimDeletedBodies(
  beforeCounts: ReadonlyMap<string, number>,
  afterCounts: ReadonlyMap<string, number>,
  beforeBlocks: readonly BlockSnapshot[],
  afterBlocks: readonly BlockSnapshot[],
  deletedCoverage: Map<string, BlockCoverage>,
  row: { source: "agent" | "writer"; actorTurnId?: string | null },
): void {
  const afterHashes = new Set(afterBlocks.map((block) => block.hash));
  const claimedByBody = new Map<string, number>();
  for (const block of beforeBlocks) {
    if (afterHashes.has(block.hash) || deletedCoverage.has(block.hash)) continue;
    const body = blockBody(block);
    const dropped = (beforeCounts.get(body) ?? 0) - (afterCounts.get(body) ?? 0);
    if (dropped <= 0) continue;
    const claimed = claimedByBody.get(body) ?? 0;
    if (claimed >= dropped) continue;
    deletedCoverage.set(block.hash, rowCoverage(row));
    claimedByBody.set(body, claimed + 1);
  }
}

function humanDeletedHashes(
  baselineBlocks: readonly BlockSnapshot[],
  finalBlocks: readonly BlockSnapshot[],
  rowDeleted: ReadonlyMap<string, BlockCoverage>,
): Set<string> {
  const finalHashes = new Set(finalBlocks.map((block) => block.hash));
  const finalCounts = counted(finalBlocks.map(blockBody));
  const baselineCounts = counted(baselineBlocks.map(blockBody));
  const claimedByBody = new Map<string, number>();
  const deleted = new Set<string>();
  for (const block of baselineBlocks) {
    if (finalHashes.has(block.hash) || rowDeleted.has(block.hash)) continue;
    const body = blockBody(block);
    const dropped = (baselineCounts.get(body) ?? 0) - (finalCounts.get(body) ?? 0);
    if (dropped <= 0) continue;
    const claimed = claimedByBody.get(body) ?? 0;
    if (claimed >= dropped) continue;
    deleted.add(block.hash);
    claimedByBody.set(body, claimed + 1);
  }
  return deleted;
}

function rowCoverage(row: {
  source: "agent" | "writer";
  actorTurnId?: string | null;
}): BlockCoverage {
  return row.source === "agent"
    ? { origin: "agent", actorTurnId: row.actorTurnId ?? undefined }
    : { origin: "writer" };
}

function claimOneByBody(
  finalByBody: Map<string, BlockSnapshot[]>,
  body: string,
  coverage: Map<string, BlockCoverage>,
  rowHashes: Set<string>,
  row: { source: "agent" | "writer"; actorTurnId?: string | null },
): void {
  for (const block of finalByBody.get(body) ?? []) {
    const prev = coverage.has(block.hash);
    const next = rowCoverage(row);
    if (prev) continue;
    coverage.set(block.hash, next);
    rowHashes.add(block.hash);
    return;
  }
}

function claimHash(
  hash: string,
  coverage: Map<string, BlockCoverage>,
  rowHashes: Set<string>,
  row: { source: "agent" | "writer"; actorTurnId?: string | null },
): void {
  const next = rowCoverage(row);
  if (coverage.has(hash)) return;
  coverage.set(hash, next);
  rowHashes.add(hash);
}

export function touchedHashesForCoverage(
  coverage: ReadonlyMap<string, BlockCoverage>,
  source: "agent" | "writer",
  actorTurnId: string | null,
): { human?: readonly string[]; agent?: readonly string[] } | undefined {
  if (source === "writer") {
    const human = [...coverage]
      .filter(([, value]) => value.origin === "writer")
      .map(([hash]) => hash);
    return human.length > 0 ? { human } : undefined;
  }
  const agent = [...coverage]
    .filter(([, value]) => value.origin === "agent" && value.actorTurnId === actorTurnId)
    .map(([hash]) => hash);
  return agent.length > 0 ? { agent } : undefined;
}

export function docFromState(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (state && state.byteLength > 0) Y.applyUpdate(doc, state);
  return doc;
}

function blocks(
  doc: Y.Doc,
  model: YProsemirrorDocumentModel,
  codec: AgentEditCodec,
): BlockSnapshot[] {
  return snapshotBlocks(toDocHandle(doc), model, codec);
}

function blockBody(block: BlockSnapshot): string {
  const separator = block.serialized.indexOf("|");
  const body = separator < 0 ? block.serialized : block.serialized.slice(separator + 1);
  return body.replace(/\s+/g, " ").trim();
}

function counted(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function multimap<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const itemKey = key(item);
    const values = map.get(itemKey) ?? [];
    values.push(item);
    map.set(itemKey, values);
  }
  return map;
}

function historicalText(update: Uint8Array | null): string {
  if (!update || update.byteLength === 0) return "";
  try {
    const parts: string[] = [];
    const decoded = Y.decodeUpdate(update);
    for (const struct of decoded.structs as Array<{ content?: { str?: unknown; arr?: unknown } }>) {
      const content = struct.content;
      if (typeof content?.str === "string") parts.push(content.str);
      if (Array.isArray(content?.arr))
        for (const item of content.arr) if (typeof item === "string") parts.push(item);
    }
    return parts.join("").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function insertedNeedles(update: Uint8Array, beforeCounts: Map<string, number>): string[] {
  const beforeBodies = [...beforeCounts.keys()];
  const needles = new Set<string>();
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return [];
  }
  for (const struct of decoded.structs as Array<{ content?: { str?: unknown; arr?: unknown } }>) {
    const content = struct.content;
    const texts: string[] = [];
    if (typeof content?.str === "string") texts.push(content.str);
    if (Array.isArray(content?.arr))
      for (const item of content.arr) if (typeof item === "string") texts.push(item);
    for (const text of texts) {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized.length >= 3 && !beforeBodies.some((body) => body.includes(normalized))) {
        needles.add(normalized);
      }
    }
  }
  return [...needles].sort((left, right) => right.length - left.length);
}
