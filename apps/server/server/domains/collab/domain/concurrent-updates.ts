/** Reduce attributed journal rows to the effective updates between two document cuts. */
import {
  bytesEqual,
  type ConcurrentUpdate,
  cloneYDoc,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";

export function partitionConcurrentUpdates(
  baselineState: Uint8Array | null,
  baselineSnapshot: Y.Snapshot,
  journalRows: readonly ConcurrentUpdate[],
  upstreamState: Uint8Array,
): ConcurrentUpdate[] {
  const rows = journalRows.filter((row) => !Y.snapshotContainsUpdate(baselineSnapshot, row.update));
  if (rows.length === 0 && baselineState && bytesEqual(baselineState, upstreamState)) return [];
  const scratch = new Y.Doc({ gc: false });
  if (baselineState?.byteLength) Y.applyUpdate(scratch, baselineState);
  try {
    const updates: ConcurrentUpdate[] = [];
    for (const row of rows) {
      const update = effectiveUpdateFromApplyingToScratch(scratch, row.update);
      if (update) updates.push({ update, origin: row.origin });
    }
    const target = yjsUpdateFromState(upstreamState);
    try {
      const residual = yjsDeltaUpdate(target, scratch);
      if (residual)
        updates.push({ update: residual, origin: { type: "human", userId: "unknown" } });
    } finally {
      target.destroy();
    }
    return updates;
  } finally {
    scratch.destroy();
  }
}

function effectiveUpdateFromApplyingToScratch(
  scratch: Y.Doc,
  update: Uint8Array,
): Uint8Array | null {
  const probe = cloneYDoc(scratch);
  try {
    Y.applyUpdate(probe, update);
    const effective = yjsDeltaUpdate(probe, scratch);
    if (!effective) return null;
    Y.applyUpdate(scratch, effective);
    return effective;
  } finally {
    probe.destroy();
  }
}
