/** Checked replay of whole response writes onto the current draft, without stale helper bytes. */
import {
  cloneYDoc,
  decodeUpdateForDependencies,
  deleteRanges,
  type JournalBatchAppendEntry,
  laterDependencyClosure,
  rangesOverlap,
  type StagedWriteRejectionReason,
  structDependencies,
  suppliedRanges,
} from "@meridian/agent-edit/integration";
import { findItem, itemIsVisible } from "@meridian/agent-edit/yjs-mutation";
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
  inverseUpdates: readonly Uint8Array[] = [],
): {
  keptEntries: JournalBatchAppendEntry[];
  rejectedWrites: { writeId: string; reason: StagedWriteRejectionReason }[];
} {
  assertNoPendingIntegration(current, "response_current", []);
  assertNoPendingIntegration(helper, "response_helper", []);
  const rows = entries.map((entry, seq) => ({ entry, seq, updateData: entry.update }));
  let dropped = new Set<(typeof rows)[number]>();
  const reasons = new Map<string, StagedWriteRejectionReason>();
  const retiredIdentities = retiredUpdates.flatMap((update) =>
    suppliedRanges(decodeUpdateForDependencies(update)),
  );
  const inverseDeletes = inverseUpdates.flatMap((update) =>
    deleteRanges(decodeUpdateForDependencies(update)),
  );
  // A logical write is atomic even when only one of its fresh-client segments fails.
  const group = (row: (typeof rows)[number]) => row.entry.mutation?.writeId;
  const planning = new Y.Doc({ gc: false });
  Y.applyUpdate(planning, planningState);
  try {
    for (;;) {
      const probe = cloneYDoc(current);
      let failed: (typeof rows)[number] | undefined;
      let reason: StagedWriteRejectionReason = "integration";
      try {
        for (const row of rows) {
          if (dropped.has(row)) continue;
          // Absence alone is normal peer concurrency. Only retirement or an
          // inverse since this cut revokes planning-visible identities. Retired
          // structs are absent; ordinary deletions of refork survivors retain them.
          const decoded = decodeUpdateForDependencies(row.updateData);
          const touched = [...deleteRanges(decoded), ...structDependencies(decoded)];
          const lostIn = (evidence: typeof touched, retirement = false) =>
            touched.some((range) =>
              evidence.some((removed) => {
                if (!rangesOverlap(range, removed)) return false;
                const start = Math.max(range.clock, removed.clock);
                const end = Math.min(range.clock + range.length, removed.clock + removed.length);
                for (let clock = start; clock < end; clock++) {
                  const id = Y.createID(range.client, clock);
                  if (
                    itemIsVisible(planning, id) &&
                    (retirement ? !findItem(current, id) : !itemIsVisible(current, id))
                  )
                    return true;
                }
                return false;
              }),
            );
          const retired = lostIn(retiredIdentities, true);
          if (retired || lostIn(inverseDeletes)) {
            reason = retired ? "discard" : "inverse";
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
      const previouslyDropped = new Set(dropped);
      dropped.add(failed);
      for (;;) {
        const before = dropped.size;
        const ids = new Set([...dropped].map(group));
        for (const row of rows) if (ids.has(group(row))) dropped.add(row);
        dropped = laterDependencyClosure(rows, dropped);
        if (dropped.size === before) break;
      }
      for (const row of dropped) {
        const writeId = group(row);
        if (!writeId) throw new Error("Staged response write has no identity");
        if (!previouslyDropped.has(row)) reasons.set(writeId, reason);
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
  return {
    keptEntries: kept.map((row) => row.entry),
    rejectedWrites: [...reasons].map(([writeId, reason]) => ({ writeId, reason })),
  };
}
