/**
 * draft-stats — the single place that turns a draft's magnitude into a label.
 *
 *   1. `wordsAdded` / `wordsRemoved` present  → `+X −Y words`
 *   2. else `proposedOperationCount` present  → `N edits`
 *   3. else no stats
 * `+N` / `−N` use the quiet diff palette. Counts are tabular so columns of
 * rows line up.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";

export type DraftStats =
  | { kind: "words"; added: number; removed: number }
  | { kind: "edits"; count: number }
  | null;

export function draftStats(draft: ThreadDraftListItem): DraftStats {
  if (typeof draft.wordsAdded === "number" || typeof draft.wordsRemoved === "number") {
    return { kind: "words", added: draft.wordsAdded ?? 0, removed: draft.wordsRemoved ?? 0 };
  }
  if (typeof draft.proposedOperationCount === "number") {
    return { kind: "edits", count: draft.proposedOperationCount };
  }
  return null;
}

/**
 * Renders a stats label. `wordsSuffix` gates the trailing " words" so the strip
 * can drop it first via a container query when space is tight.
 */
export function DraftStatsLabel({
  stats,
  wordsSuffix = true,
}: {
  stats: DraftStats;
  wordsSuffix?: boolean;
}) {
  if (!stats) return null;
  if (stats.kind === "edits") {
    return (
      <span className="tabular-nums text-ink-muted">
        {stats.count} {stats.count === 1 ? "edit" : "edits"}
      </span>
    );
  }
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
      {wordsSuffix ? <span className="@max-[430px]:hidden text-ink-muted"> words</span> : null}
    </span>
  );
}
