/**
 * ActivityRow — the visual primitive for one entry in an assistant turn's
 * activity timeline.
 *
 * Replaces the card-altitude `ToolCard` with a text-altitude row matching the
 * design system's "text, not a card" disclosure altitude. Used by every
 * block kind in `ActivityBlock`: tools, reasoning, prose fallbacks.
 *
 * Two layout modes from one component — picked by props, not a `mode` enum:
 *
 *  1. **Action layout** (`title` set) — a single-line `icon + title + status
 *     + chevron` row. Used by tool rows and other "verb noun" actions. If
 *     `expand` is set, clicking the row toggles an inline curated fold.
 *
 *  2. **Prose layout** (`children` set, no `title`) — `icon + paragraph`
 *     side-by-side, so a multiline reasoning block aligns the prose against
 *     the icon's baseline instead of stacking under it. This was the misalign
 *     bug in v1: rendering `<icon-only-row>` then `<prose-block>` with a left
 *     pad below the icon left a gap between the icon and the first line.
 *
 * **Timeline rail (self-contained).** Each row paints its own piece of the
 * Claude-style process timeline inside the icon column: the chip sits at the
 * top and a 1px `flex-1` span fills the remaining vertical space down to the
 * row's bottom edge. Because the icon column stretches to the full row height
 * (parent uses `items-stretch`) and rows stack with no margin between them,
 * the line in row N visually meets the icon in row N+1 — producing a
 * continuous rail without any sibling-aware CSS, data attributes, pseudo-
 * elements, or stacking-context tricks. Text blocks render outside this
 * component as full-width prose, so they naturally break the rail.
 *
 * Why self-contained: an earlier version used `[data-activity-row]` plus
 * `:has(+)` and adjacent-sibling pseudo-elements. That worked only when every
 * row was a *direct* DOM sibling, which broke as soon as a wrapper appeared
 * between runs (e.g. `<div data-fold-activity-run>` around tool runs while
 * reasoning runs render as fragments). Pulling the rail into the row itself
 * makes the structural assumption local — the row owns the rail, the
 * surrounding markup is free to nest however it wants. The
 * `data-activity-row` attribute survives only as a stable test/structural
 * marker for "this is one rendered timeline row" — no CSS keys off it.
 */
import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

export type ActivityRowStatus = "running" | "done" | "error";

export type ActivityRowProps = {
  Icon: LucideIcon;
  /** Single-line action title (e.g. `Read foo.md`). Omit when using `children`. */
  title?: ReactNode;
  /** Status indicator. Hidden when the row is `done` and not interactive. */
  status?: ActivityRowStatus;
  /** Inline expandable content (curated — no raw JSON). Click toggles fold. */
  expand?: ReactNode;
  /**
   * Multiline prose body (reasoning paragraphs, text fallbacks). When `title`
   * is omitted, this lays out side-by-side with the icon. When `title` is
   * present, it stacks below the title row in the right column.
   */
  children?: ReactNode;
  /** Optional className applied to the prose container — for variant tinting. */
  proseClassName?: string;
};

/**
 * Per-row vertical rhythm. Lives on the icon column AND content column so the
 * line's start (below the chip) and the prose's first baseline both pick up
 * the same top inset. Adjacent rows therefore share `ICON_TOP_PAD + chip + 1
 * mt-1` of breathing room between icons — enough to feel separated, small
 * enough to read as a single continuous rail.
 */
const ICON_TOP_PAD = "pt-[3px]";

export function ActivityRow({
  Icon,
  title,
  status,
  expand,
  children,
  proseClassName,
}: ActivityRowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const hasInlineFold = !!expand;

  // Icon column owns the rail. `items-stretch` on the row + `flex-1` on the
  // line span makes the rail fill from below the chip to the row's bottom
  // edge regardless of how tall the content column grows.
  const iconColumn = (
    <div className={cn("flex w-[19px] shrink-0 flex-col items-center", ICON_TOP_PAD)}>
      <span className="grid size-[19px] shrink-0 place-items-center rounded-md bg-chip-muted-bg text-ink-subtle">
        <Icon className="size-3" aria-hidden />
      </span>
      <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
    </div>
  );

  // Prose layout: no title, just children. Side-by-side with the icon so a
  // multiline paragraph's first line aligns to the chip and subsequent lines
  // wrap under it (in the content column, never under the icon column).
  if (!title && children) {
    return (
      <div className="flex items-stretch gap-2.5" data-activity-row>
        {iconColumn}
        <div
          className={cn(
            "min-w-0 flex-1 pb-2 text-compact text-muted-foreground",
            ICON_TOP_PAD,
            proseClassName,
          )}
        >
          {children}
        </div>
      </div>
    );
  }

  const dot =
    status === "running" ? (
      <span
        className="bg-status-live-dot mt-[7px] size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
        aria-hidden
      />
    ) : status === "error" ? (
      <span
        className="mt-[7px] size-1.5 shrink-0 rounded-full bg-destructive"
        role="img"
        aria-label="Failed"
      />
    ) : null;

  const titleRowContent = (
    <div className="flex w-full items-start gap-2.5">
      {title ? (
        <span className="text-prose-foreground min-w-0 flex-1 truncate text-compact">{title}</span>
      ) : null}
      {dot}
      {hasInlineFold ? (
        <ChevronRight
          className={cn(
            "mt-1.5 size-3 shrink-0 text-ink-subtle transition-transform duration-200",
            open && "rotate-90",
          )}
          aria-hidden
        />
      ) : null}
    </div>
  );

  // Outer container is the flex row (icon column + content column). The
  // interactive button — if any — wraps only the title content, not the icon
  // column, because the icon column owns the rail and the rail must extend
  // through the row's full height including any inline-fold body.
  return (
    <div className="flex items-stretch gap-2.5" data-activity-row>
      {iconColumn}
      <div className={cn("min-w-0 flex-1 pb-2", ICON_TOP_PAD)}>
        {hasInlineFold ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={panelId}
            className="focus-ring -mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-start rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted"
          >
            {titleRowContent}
          </button>
        ) : (
          titleRowContent
        )}

        {title && children ? (
          <div className={cn("mt-1 text-compact text-muted-foreground", proseClassName)}>
            {children}
          </div>
        ) : null}

        {hasInlineFold ? (
          <div
            id={panelId}
            className={cn(
              "grid transition-[grid-template-rows] duration-200 ease-out",
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-w-0 overflow-hidden">
              <div className="mt-1.5">{expand}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
