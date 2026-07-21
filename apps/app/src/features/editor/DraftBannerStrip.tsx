/**
 * DraftBannerStrip — shared container for the editor's draft-chrome banner.
 *
 * DraftReviewHeader renders its content inside this strip. The pending-changes
 * state is handled by DraftReviewChip in the identity bar instead.
 */
import type { ReactNode } from "react";

export type DraftBannerStripProps = {
  /** Status label shown next to the jade dot (e.g. "AI changes ready for review"). */
  label: ReactNode;
  /** Right-aligned action cluster (Review, Apply all / Discard all, etc.). */
  actions: ReactNode;
  /** Optional leading element before the dot+label (e.g. Back to live button). */
  leading?: ReactNode;
  /** Optional alert below the label row (e.g. stale-draft warning). */
  alert?: ReactNode;
  /** Passthrough data-* attributes for test selectors. */
  [key: `data-${string}`]: unknown;
};

export function DraftBannerStrip({
  label,
  actions,
  leading,
  alert,
  ...dataAttrs
}: DraftBannerStripProps) {
  return (
    <section
      className="flex min-h-7 shrink-0 flex-wrap items-center gap-1.5 border-border border-b bg-dock-surface px-2.5 text-caption"
      role="status"
      aria-live="polite"
      {...dataAttrs}
    >
      {leading}
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary opacity-70" />
        <span className="truncate">{label}</span>
      </span>
      {alert}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
    </section>
  );
}
