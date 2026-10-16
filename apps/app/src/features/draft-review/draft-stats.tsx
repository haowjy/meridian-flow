/** Word deltas for chat edit receipts and the draft dock's files, rendered in the quiet diff palette. */
import { groupWordDelta, type ReviewGroup } from "@meridian/agent-edit/diff";
import type { ReviewChange } from "./review-model";

export type DraftStats = { kind: "words"; added: number; removed: number } | null;

const groupsById = new WeakMap<object, Map<string, ReviewGroup>>();

/** The words some review changes add and remove, counted as the receipt counts them; null when none has text. */
export function changeWordStats(changes: readonly ReviewChange[]): DraftStats {
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const { id, frame } of changes) {
    if (!frame) continue;
    let groups = groupsById.get(frame);
    if (!groups) {
      groups = new Map(frame.groups.map((group) => [group.id, group]));
      groupsById.set(frame, groups);
    }
    const group = groups.get(id);
    if (!group) continue;
    const delta = groupWordDelta(frame.diff, group);
    added += delta.wordsAdded;
    removed += delta.wordsRemoved;
    counted = true;
  }
  return counted ? { kind: "words", added, removed } : null;
}

/** Several files' word deltas as one; null when none was counted. */
export function sumWordStats(all: readonly DraftStats[]): DraftStats {
  return all.reduce<DraftStats>(
    (sum, stats) =>
      stats
        ? {
            kind: "words",
            added: (sum?.added ?? 0) + stats.added,
            removed: (sum?.removed ?? 0) + stats.removed,
          }
        : sum,
    null,
  );
}

export function DraftStatsLabel({ stats }: { stats: DraftStats }) {
  if (!stats) return null;
  // A zero side is noise ("+6 −0" reads worse than "+6"); drop it. Both-zero
  // means no visible word change — render nothing rather than "+0 −0".
  if (stats.added === 0 && stats.removed === 0) return null;
  return (
    <span className="tabular-nums">
      {stats.added > 0 ? (
        <span className="text-diff-added">+{stats.added.toLocaleString()}</span>
      ) : null}
      {stats.added > 0 && stats.removed > 0 ? " " : null}
      {stats.removed > 0 ? (
        <span className="text-diff-removed">−{stats.removed.toLocaleString()}</span>
      ) : null}
      <span className="@max-[430px]:hidden text-ink-muted"> words</span>
    </span>
  );
}
