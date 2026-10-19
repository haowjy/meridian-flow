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
  suppliedRanges,
} from "@meridian/agent-edit/integration";
import { findItem, itemIsVisible } from "@meridian/agent-edit/yjs-mutation";
import * as Y from "yjs";
import { assertNoPendingIntegration, DraftPeerIntegrationError } from "./branch-push-plan.js";

/**
 * Mutates only this disposable candidate; caller persists it under its existing draft lock.
 * `cut` is the room's snapshot where the scope began writing: only a retirement or an inverse
 * since it revokes an identity the writes could have planned on.
 */
export function reconcileStagedDraftWrites(
  current: Y.Doc,
  entries: readonly JournalBatchAppendEntry[],
  retiredUpdates: readonly Uint8Array[],
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
  const retiredIdentities = retiredUpdates.flatMap((update) =>
    suppliedRanges(decodeUpdateForDependencies(update)),
  );
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
                  visibleAtCut(cut, current, id) &&
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
 * ancestors; a retired one, gone from `current`, by its own identity.
 */
function visibleAtCut(cut: Y.Snapshot, current: Y.Doc, id: Y.ID): boolean {
  const born = (at: Y.ID) => at.clock < (cut.sv.get(at.client) ?? 0) && !Y.isDeleted(cut.ds, at);
  const item = findItem(current, id);
  if (!item) return born(id);
  for (let node: Y.Item | null = item; node; node = (node.parent as Y.AbstractType<unknown>)._item)
    if (!born(node.id)) return false;
  return true;
}
