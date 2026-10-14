/**
 * The row a Discard leaves behind on a surface without an editor: "Discarding" with Cancel while its
 * room is acquired, "Discarded" with an Undo button once the edit exists (until the writer leaves), or
 * the failure on the row when the edit did not land. A change keeps its excerpt;
 * a whole file keeps its name.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { cn } from "@/lib/utils";
import { changeExcerpt } from "./review-model";
import type { DiscardedEntry } from "./useHeadlessDiscards";

export function DiscardedRow({
  entry,
  name,
  touch = false,
  onUndo,
  className,
}: {
  entry: Pick<DiscardedEntry, "id" | "change" | "phase">;
  name: string;
  touch?: boolean;
  onUndo: () => void;
  className?: string;
}) {
  const label = entry.change
    ? changeExcerpt(entry.change)
        .map((run) => run.text)
        .join(" ")
    : name;
  const failed = entry.phase === "failed";
  const pending = entry.phase === "pending";
  return (
    <li
      data-discarded-row={entry.id}
      className={cn(
        "flex items-center gap-2 px-2 text-caption text-ink-muted",
        touch ? "min-h-11" : "min-h-7",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span
        role={failed ? "alert" : "status"}
        aria-busy={pending}
        className={cn("shrink-0", failed && "text-destructive")}
      >
        {failed ? (
          <Trans>Couldn't discard. Try again.</Trans>
        ) : pending ? (
          <Trans>Discarding</Trans>
        ) : (
          <Trans>Discarded</Trans>
        )}
      </span>
      <button
        type="button"
        onClick={onUndo}
        className={cn(
          "focus-ring shrink-0 rounded-sm px-1 py-0.5 text-foreground hover:underline",
          touch && "min-h-11 min-w-11",
        )}
      >
        {failed ? t`Dismiss` : pending ? t`Cancel` : t`Undo`}
      </button>
    </li>
  );
}
