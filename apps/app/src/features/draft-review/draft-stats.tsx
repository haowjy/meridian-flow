/** Word deltas for chat edit receipts, rendered in the quiet diff palette. */
export type DraftStats = { kind: "words"; added: number; removed: number } | null;

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
