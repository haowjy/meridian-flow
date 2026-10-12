/** Checked replay of whole response writes onto the current draft, without stale helper bytes. */
import {
  cloneYDoc,
  decodeUpdateForDependencies,
  deleteRanges,
  type JournalBatchAppendEntry,
  laterDependencyClosure,
  structDependencies,
  suppliedRanges,
} from "@meridian/agent-edit/integration";
import { itemIsVisible } from "@meridian/agent-edit/yjs-mutation";
import * as Y from "yjs";
import { assertNoPendingIntegration, BranchPeerIntegrationError } from "./branch-push-plan.js";
import { subtractRanges } from "./branch-review-closure.js";

/** Mutates only this disposable candidate; caller persists it under its existing branch lock. */
export function reconcileStagedBranchWrites(
  current: Y.Doc,
  helper: Y.Doc,
  entries: readonly JournalBatchAppendEntry[],
  retiredUpdates: readonly Uint8Array[],
  planningState: Uint8Array,
): JournalBatchAppendEntry[] {
  assertNoPendingIntegration(current, "response_current", []);
  assertNoPendingIntegration(helper, "response_helper", []);
  const rows = entries.map((entry, seq) => ({ entry, seq, updateData: entry.update }));
  let dropped = new Set<(typeof rows)[number]>();
  // A logical write is atomic even when only one of its fresh-client segments fails.
  const group = (row: (typeof rows)[number]) => row.entry.mutation?.writeId;
  const planning = new Y.Doc({ gc: false });
  Y.applyUpdate(planning, planningState);
  try {
    for (;;) {
      const probe = cloneYDoc(current);
      let failed: (typeof rows)[number] | undefined;
      try {
        for (const row of rows) {
          if (dropped.has(row)) continue;
          // Inverse edits retain tombstones in the same generation. Physical
          // integration alone would silently write beside the restored text.
          const decoded = decodeUpdateForDependencies(row.updateData);
          const touched = [...deleteRanges(decoded), ...structDependencies(decoded)];
          const lostText = touched.some((range) =>
            Array.from({ length: range.length }, (_, offset) =>
              Y.createID(range.client, range.clock + offset),
            ).some((id) => itemIsVisible(planning, id) && !itemIsVisible(current, id)),
          );
          if (lostText) {
            failed = row;
            break;
          }
          Y.applyUpdate(probe, row.updateData);
          try {
            assertNoPendingIntegration(probe, "response_replay", []);
          } catch (cause) {
            if (!(cause instanceof BranchPeerIntegrationError)) throw cause;
            failed = row;
            break;
          }
        }
      } finally {
        probe.destroy();
      }
      if (!failed) break;
      if (!group(failed)) throw new Error("Staged response write has no identity");
      dropped.add(failed);
      for (;;) {
        const before = dropped.size;
        const ids = new Set([...dropped].map(group));
        for (const row of rows) if (ids.has(group(row))) dropped.add(row);
        dropped = laterDependencyClosure(rows, dropped);
        if (dropped.size === before) break;
      }
    }
  } finally {
    planning.destroy();
  }
  const kept = rows.filter((row) => !dropped.has(row));
  for (const row of kept) Y.applyUpdate(current, row.updateData);
  assertNoPendingIntegration(current, "response_replay", []);

  // The helper may retain only generation-retired rows and rejected writes.
  // Delete sets are cumulative: subtract the admitted cut before checking them.
  const residual = decodeUpdateForDependencies(
    Y.encodeStateAsUpdate(helper, Y.encodeStateVector(current)),
  );
  const currentDeletes = deleteRanges(decodeUpdateForDependencies(Y.encodeStateAsUpdate(current)));
  const explained = [...retiredUpdates, ...[...dropped].map((row) => row.updateData)].map(
    decodeUpdateForDependencies,
  );
  const inserted = explained.flatMap(suppliedRanges),
    deleted = explained.flatMap(deleteRanges);
  if (
    subtractRanges(suppliedRanges(residual), inserted).length ||
    subtractRanges(subtractRanges(deleteRanges(residual), currentDeletes), deleted).length
  )
    throw new Error("Response publication left an unexplained generation residual");
  // Never merge helper state into the candidate, even when the residual is explained.
  return kept.map((row) => row.entry);
}
