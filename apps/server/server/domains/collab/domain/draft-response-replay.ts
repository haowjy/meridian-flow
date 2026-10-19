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
import { itemIsVisible } from "@meridian/agent-edit/yjs-mutation";
import * as Y from "yjs";
import type { ClockRange } from "./document-content.js";

/** Mutates only this disposable candidate; caller persists it under its existing draft lock. */
export function reconcileStagedDraftWrites(
  current: Y.Doc,
  helper: Y.Doc,
  entries: readonly JournalBatchAppendEntry[],
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
          const lostIn = (evidence: typeof touched) =>
            touched.some((range) =>
              evidence.some((removed) => {
                if (!rangesOverlap(range, removed)) return false;
                const start = Math.max(range.clock, removed.clock);
                const end = Math.min(range.clock + range.length, removed.clock + removed.length);
                for (let clock = start; clock < end; clock++) {
                  const id = Y.createID(range.client, clock);
                  if (itemIsVisible(planning, id) && !itemIsVisible(current, id)) return true;
                }
                return false;
              }),
            );
          if (lostIn(inverseDeletes)) {
            reason = "inverse";
            failed = row;
            break;
          }
          Y.applyUpdate(probe, row.updateData);
          try {
            assertNoPendingIntegration(probe, "response_replay", []);
          } catch (cause) {
            if (!(cause instanceof DraftPeerIntegrationError)) throw cause;
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

  // The helper may retain only rejected writes.
  // Delete sets are cumulative: subtract the admitted cut before checking them.
  const residual = decodeUpdateForDependencies(
    Y.encodeStateAsUpdate(helper, Y.encodeStateVector(current)),
  );
  const currentDeletes = deleteRanges(decodeUpdateForDependencies(Y.encodeStateAsUpdate(current)));
  const explained = [...dropped].map((row) => row.updateData).map(decodeUpdateForDependencies);
  const inserted = explained.flatMap(suppliedRanges),
    deleted = explained.flatMap(deleteRanges);
  if (
    subtractRanges(suppliedRanges(residual), inserted).length ||
    subtractRanges(subtractRanges(deleteRanges(residual), currentDeletes), deleted).length
  )
    throw new Error("Response segment write left an unexplained helper residual");
  // Never merge helper state into the candidate, even when the residual is explained.
  return {
    keptEntries: kept.map((row) => row.entry),
    rejectedWrites: [...reasons].map(([writeId, reason]) => ({ writeId, reason })),
  };
}

class DraftPeerIntegrationError extends Error {
  constructor(
    readonly operation: string,
    readonly journalIds: readonly number[],
  ) {
    super(`${operation} left pending Yjs dependencies for journal rows ${journalIds.join(",")}`);
    this.name = "DraftPeerIntegrationError";
  }
}

export function assertNoPendingIntegration(
  doc: Y.Doc,
  operation: string,
  journalIds: readonly number[],
): void {
  const { pendingStructs, pendingDs } = doc.store;
  if (hasPending(pendingStructs) || hasPending(pendingDs)) {
    throw new DraftPeerIntegrationError(operation, journalIds);
  }
}

function hasPending(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Uint8Array) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function subtractRanges(
  ranges: readonly ClockRange[],
  excluded: readonly ClockRange[],
): ClockRange[] {
  return ranges.flatMap((range) => {
    let remaining = [range];
    for (const cut of excluded) {
      remaining = remaining.flatMap((part) => {
        if (!rangesOverlap(part, cut)) return [part];
        const end = part.clock + part.length;
        const cutEnd = cut.clock + cut.length;
        return [
          ...(part.clock < cut.clock ? [{ ...part, length: cut.clock - part.clock }] : []),
          ...(cutEnd < end ? [{ ...part, clock: cutEnd, length: end - cutEnd }] : []),
        ];
      });
    }
    return remaining;
  });
}
