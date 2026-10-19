/** Checked replay of whole response writes onto the current draft, against the scope's cut. */
import {
  cloneYDoc,
  decodeUpdateForDependencies,
  deleteRanges,
  type JournalBatchAppendEntry,
  laterDependencyClosure,
  rangesOverlap,
  type StagedWriteRejectionReason,
  structDependencies,
} from "@meridian/agent-edit/integration";
import { findItem, itemIsVisible } from "@meridian/agent-edit/yjs-mutation";
import * as Y from "yjs";

/**
 * Mutates only this disposable candidate; caller persists it under its existing draft lock.
 * `cut` is the room's snapshot where the scope began writing: only an inverse
 * since it revokes an identity the writes could have planned on.
 */
export function reconcileStagedDraftWrites(
  current: Y.Doc,
  entries: readonly JournalBatchAppendEntry[],
  cut: Y.Snapshot,
  inverseUpdates: readonly Uint8Array[] = [],
): {
  keptEntries: JournalBatchAppendEntry[];
  rejectedWrites: { writeId: string; reason: StagedWriteRejectionReason }[];
} {
  assertNoPendingIntegration(current, "response_current", []);
  const rows = entries.map((entry, seq) => ({ entry, seq, updateData: entry.update }));
  let dropped = new Set<(typeof rows)[number]>();
  const reasons = new Map<string, StagedWriteRejectionReason>();
  const inverseDeletes = inverseUpdates.flatMap((update) =>
    deleteRanges(decodeUpdateForDependencies(update)),
  );
  // A logical write is atomic even when only one of its fresh-client segments fails.
  const group = (row: (typeof rows)[number]) => row.entry.mutation?.writeId;
  for (;;) {
    const probe = cloneYDoc(current);
    let failed: (typeof rows)[number] | undefined;
    let reason: StagedWriteRejectionReason = "integration";
    try {
      for (const row of rows) {
        if (dropped.has(row)) continue;
        // Absence alone is normal peer concurrency. Only an explicit inverse
        // since this cut revokes planning-visible identities.
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
                if (visibleAtCut(cut, current, id) && !itemIsVisible(current, id)) return true;
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
  const kept = rows.filter((row) => !dropped.has(row));
  for (const row of kept) Y.applyUpdate(current, row.updateData);
  assertNoPendingIntegration(current, "response_replay", []);
  return {
    keptEntries: kept.map((row) => row.entry),
    rejectedWrites: [...reasons].map(([writeId, reason]) => ({ writeId, reason })),
  };
}

/**
 * Whether `id` was visible at the cut. A struct `current` still holds is judged with its
 * ancestors; an absent one by its own identity.
 */
function visibleAtCut(cut: Y.Snapshot, current: Y.Doc, id: Y.ID): boolean {
  const born = (at: Y.ID) => at.clock < (cut.sv.get(at.client) ?? 0) && !Y.isDeleted(cut.ds, at);
  const item = findItem(current, id);
  if (!item) return born(id);
  for (let node: Y.Item | null = item; node; node = (node.parent as Y.AbstractType<unknown>)._item)
    if (!born(node.id)) return false;
  return true;
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
