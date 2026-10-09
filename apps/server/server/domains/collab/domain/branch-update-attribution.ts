/** Block-coverage attribution for concurrent updates during agent editing. */
import {
  type AgentEditCodec,
  type BlockSnapshot,
  type ConcurrentUpdateOrigin,
  snapshotBlocks,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";

export type AttributionRow = {
  id: number;
  origin: ConcurrentUpdateOrigin;
  update: Uint8Array;
};

type BlockCoverage = ConcurrentUpdateOrigin;

type PartitionByBlockCoverageInput = {
  baselineState: Uint8Array | null;
  upstreamState: Uint8Array;
  rows: readonly AttributionRow[];
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
};

export function partitionByBlockCoverage(inputs: PartitionByBlockCoverageInput): {
  coverage: Map<string, BlockCoverage>;
  humanResidualHashes: Set<string>;
  deletedCoverage: Map<string, BlockCoverage>;
  humanDeletedHashes: Set<string>;
} {
  // A live row can reach preflight before the Work draft. Final coverage must
  // use the CRDT join, never compare the newer baseline to an older upstream.
  const finalDoc = docFromState(inputs.baselineState);
  Y.applyUpdate(finalDoc, inputs.upstreamState);
  for (const row of inputs.rows) Y.applyUpdate(finalDoc, row.update);
  const scratch = docFromState(inputs.baselineState);
  try {
    const finalBlocks = blocks(finalDoc, inputs.model, inputs.codec);
    const baselineBlocks = blocks(scratch, inputs.model, inputs.codec);
    const baselineByIdentity = new Map(
      baselineBlocks.map((block) => [blockIdentity(block), block]),
    );
    const coverage = new Map<string, BlockCoverage>();
    const deletedCoverage = new Map<string, BlockCoverage>();
    const finalByIdentity = new Map(finalBlocks.map((block) => [blockIdentity(block), block]));
    for (const row of inputs.rows) {
      const beforeBlocks = blocks(scratch, inputs.model, inputs.codec);
      Y.applyUpdate(scratch, row.update);
      const afterBlocks = blocks(scratch, inputs.model, inputs.codec);
      const beforeByIdentity = new Map(beforeBlocks.map((block) => [blockIdentity(block), block]));
      const afterByIdentity = new Map(afterBlocks.map((block) => [blockIdentity(block), block]));
      for (const block of beforeBlocks) {
        if (!afterByIdentity.has(blockIdentity(block))) {
          recordCoverage(deletedCoverage, block.hash, row.origin);
        }
      }
      for (const block of afterBlocks) {
        const identity = blockIdentity(block);
        const before = beforeByIdentity.get(identity);
        const final = finalByIdentity.get(identity);
        if ((!before || before.serialized !== block.serialized) && final) {
          recordCoverage(coverage, final.hash, row.origin);
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

/** Maintenance accounts for changed bytes, but never replaces an authored block's credit. */
function recordCoverage(
  coverage: Map<string, BlockCoverage>,
  hash: string,
  origin: ConcurrentUpdateOrigin,
): void {
  if (origin.type !== "system" || !coverage.has(hash)) coverage.set(hash, origin);
}

export function touchedHashesForCoverage(
  coverage: ReadonlyMap<string, BlockCoverage>,
  origin: ConcurrentUpdateOrigin,
): { human?: readonly string[]; agent?: readonly string[] } | undefined {
  if (origin.type === "system") return undefined;
  const hashes = [...coverage]
    .filter(
      ([, value]) =>
        value.type === origin.type &&
        (value.type !== "agent" ||
          (origin.type === "agent" && value.actorTurnId === origin.actorTurnId)),
    )
    .map(([hash]) => hash);
  return hashes.length > 0 ? { [origin.type]: hashes } : undefined;
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
