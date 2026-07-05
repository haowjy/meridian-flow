/**
 * draft-stats — the single place that turns a draft's magnitude into a label.
 *
 * Word deltas are not on the wire yet (server phase follows). Everything reads
 * through here so lighting them up later is a one-file change:
 *   1. `wordsAdded` / `wordsRemoved` present  → `+X −Y words`
 *   2. else `proposedOperationCount` present  → `N edits`
 *   3. else no stats
 * `+N` paints jade, `−N` subtle; deletions are NEVER red (this is progress,
 * not danger). Counts are tabular so columns of rows line up.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";

/**
 * Word deltas are optional forward-compat fields the server does not send yet.
 * Feature-detect them off the wire row rather than widening the contract before
 * the data exists.
 */
type DraftStatsSource = ThreadDraftListItem & {
  wordsAdded?: number | null;
  wordsRemoved?: number | null;
};

export type DraftStats =
  | { kind: "words"; added: number; removed: number }
  | { kind: "edits"; count: number }
  | null;

export function draftStats(draft: ThreadDraftListItem): DraftStats {
  const source = draft as DraftStatsSource;
  if (typeof source.wordsAdded === "number" || typeof source.wordsRemoved === "number") {
    return { kind: "words", added: source.wordsAdded ?? 0, removed: source.wordsRemoved ?? 0 };
  }
  if (typeof draft.proposedOperationCount === "number") {
    return { kind: "edits", count: draft.proposedOperationCount };
  }
  return null;
}

/** Net stats across a changeset's representative drafts (one per document). */
export function aggregateDraftStats(drafts: ThreadDraftListItem[]): DraftStats {
  const per = drafts.map(draftStats);
  if (per.length > 0 && per.every((stat) => stat?.kind === "words")) {
    return per.reduce<DraftStats>(
      (acc, stat) => {
        if (acc?.kind !== "words" || stat?.kind !== "words") return acc;
        return {
          kind: "words",
          added: acc.added + stat.added,
          removed: acc.removed + stat.removed,
        };
      },
      { kind: "words", added: 0, removed: 0 },
    );
  }
  if (per.length > 0 && per.every((stat) => stat?.kind === "edits")) {
    const count = per.reduce((sum, stat) => sum + (stat?.kind === "edits" ? stat.count : 0), 0);
    return { kind: "edits", count };
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
  return (
    <span className="tabular-nums">
      <span className="text-jade-text">+{stats.added.toLocaleString()}</span>{" "}
      <span className="text-ink-subtle">−{stats.removed.toLocaleString()}</span>
      {wordsSuffix ? <span className="@max-[360px]:hidden text-ink-muted"> words</span> : null}
    </span>
  );
}
