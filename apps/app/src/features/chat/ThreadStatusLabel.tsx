/**
 * ThreadStatusLabel — the writer-facing rendering of a derived `ThreadStatus`.
 *
 * The label names what the thread is doing; the moving dot carries "awake" so
 * the text stays a single fact. Asleep is a still dot. No separator glyphs.
 */
import { t } from "@lingui/core/macro";
import type { ThreadStatus } from "@meridian/contracts/threads";
import { cn } from "@/lib/utils";

export type ThreadStatusLabelProps = {
  status: ThreadStatus;
  className?: string;
};

export function ThreadStatusLabel({ status, className }: ThreadStatusLabelProps) {
  if (status.kind === "asleep") {
    return (
      <span
        className={cn("inline-flex items-center gap-1.5 text-caption text-ink-subtle", className)}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-live-dot" />
        {t`Asleep`}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption text-ink-muted", className)}>
      <span aria-hidden className="streaming-dot" />
      {status.phase === "generating" ? t`Generating` : t`Waiting`}
    </span>
  );
}
