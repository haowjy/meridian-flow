/** Neutral block-coverage attribution shared by agent editing and branch push planning. */
import {
  type AgentEditCodec,
  type BlockSnapshot,
  snapshotBlocks,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
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
} {
  const finalDoc = docFromState(inputs.upstreamState);
  const scratch = docFromState(inputs.baselineState);
  try {
    const finalBlocks = blocks(finalDoc, inputs.model, inputs.codec);
    const baselineBlocks = blocks(scratch, inputs.model, inputs.codec);
    const baselineByIdentity = new Map(
      baselineBlocks.map((block) => [blockIdentity(block), block]),
    );
    const coverage = new Map<string, BlockCoverage>();
    const deletedCoverage = new Map<string, BlockCoverage>();
    for (const row of inputs.rows) {
      const beforeBlocks = blocks(scratch, inputs.model, inputs.codec);
      Y.applyUpdate(scratch, row.update);
      const afterBlocks = blocks(scratch, inputs.model, inputs.codec);
      const beforeByIdentity = new Map(beforeBlocks.map((block) => [blockIdentity(block), block]));
      const afterByIdentity = new Map(afterBlocks.map((block) => [blockIdentity(block), block]));
      const finalByIdentity = new Map(finalBlocks.map((block) => [blockIdentity(block), block]));
      for (const block of beforeBlocks) {
        if (!afterByIdentity.has(blockIdentity(block))) {
          deletedCoverage.set(block.hash, rowCoverage(row));
        }
      }
      for (const block of afterBlocks) {
        const identity = blockIdentity(block);
        const before = beforeByIdentity.get(identity);
        const final = finalByIdentity.get(identity);
        if ((!before || before.serialized !== block.serialized) && final) {
          coverage.set(final.hash, rowCoverage(row));
        }
      }
    }
    const humanDeleted = humanDeletedHashes(baselineBlocks, finalBlocks, deletedCoverage);
    const residual = new Set<string>();
    for (const block of finalBlocks) {
      if (coverage.has(block.hash)) continue;
      const baseline = baselineByIdentity.get(blockIdentity(block));
      if (!baseline || baseline.serialized !== block.serialized) residual.add(block.hash);
    }
    return {
      coverage,
      humanResidualHashes: residual,
      deletedCoverage,
      humanDeletedHashes: humanDeleted,
    };
  } finally {
    finalDoc.destroy();
    scratch.destroy();
  }
}

function humanDeletedHashes(
  baselineBlocks: readonly BlockSnapshot[],
  finalBlocks: readonly BlockSnapshot[],
  rowDeleted: ReadonlyMap<string, BlockCoverage>,
): Set<string> {
  const finalIdentities = new Set(finalBlocks.map(blockIdentity));
  const deleted = new Set<string>();
  for (const block of baselineBlocks) {
    if (!finalIdentities.has(blockIdentity(block)) && !rowDeleted.has(block.hash)) {
      deleted.add(block.hash);
    }
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

function blockIdentity(block: BlockSnapshot): string {
  return `${block.clientID}:${block.clock}`;
}
