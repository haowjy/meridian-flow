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
 * **Two actions, one row (the stretched-button pattern).** A row both expands
 * and, where its title names a document, navigates. The large forgiving target
 * carries the safe reversible action (expand); the small precise target
 * carries the consequential one (leaving the transcript). So the toggle is an
 * empty absolutely-positioned button rendered *after* the title content, and
 * any door inside the title sits above it. They are DOM siblings, never
 * nested: a `<button>` authored inside a `<button>` in JSX is not rescued the
 * way the HTML parser rescues static markup, and it breaks screen readers.
 * The stretched area covers the title row only, so clicking inside an open
 * expand never collapses it.
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
  /** Preserve the rail gutter while omitting a redundant per-row icon chip. */
  quietIcon?: boolean;
  /** Single-line action title (e.g. `Read foo.md`). Omit when using `children`. */
  title?: ReactNode;
  /** Status indicator. Hidden when the row is `done` and not interactive. */
  status?: ActivityRowStatus;
  /**
   * Inline expandable content (curated — no raw JSON). Click toggles fold.
   *
   * A thunk, not a node: a settled turn can hold a dozen closed rows, and none
   * of them should build a payload nobody has asked to see. Passing the thunk
   * at all is the row's promise that there *is* something behind it — an
   * expand affordance with nothing behind it is worse than none.
   */
  expand?: () => ReactNode;
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
 * the same top inset.
 */
const ICON_TOP_PAD = "pt-[3px]";

/**
 * The title row's own vertical padding. Shared with the icon column, which
 * wears it too so the chip's box and the title's box start and end together.
 */
const TITLE_ROW_PAD = "py-0.5";

/**
 * One line of compact text, derived from the same two tokens the title and the
 * prose body set. The chip centres inside this rather than sitting at the top
 * of the column: a 19px chip against a 20.8px line box is not centred by
 * matching their tops, and every future type or padding change would need the
 * offset re-tuned. Centring on the line box holds by construction.
 */
const COMPACT_LINE_BOX =
  // `box-content` so the min-height describes the line box itself, leaving the
  // content column's padding to be added on top of it exactly as the title row
  // adds it.
  "box-content min-h-[calc(var(--text-compact)*var(--text-compact--line-height))]";

/**
 * Left inset that puts non-row content on the same text edge as a row's
 * content column: the 19px icon gutter plus the row's `gap-2.5`.
 *
 * Exported because content that deliberately breaks the timeline (assistant
 * prose inside a process fold) still has to agree with it on where text
 * starts. Owning the number here keeps the two from drifting — a fold whose
 * prose sits 29px left of every row around it reads as a broken rail rather
 * than a change of register.
 */
export const ACTIVITY_ROW_TEXT_INSET = "pl-[29px]";

export function ActivityRow({
  Icon,
  quietIcon = false,
  title,
  status,
  expand,
  children,
  proseClassName,
}: ActivityRowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = `${panelId}-title`;

  const hasInlineFold = !!expand;

  // Icon column owns the rail. `items-stretch` on the row + `flex-1` on the
  // line span makes the rail fill from below the chip to the row's bottom
  // edge regardless of how tall the content column grows.
  // `flex-col` is load-bearing, not stylistic: `flex-1` grows along the main
  // axis, so in a row-direction parent it overrides `w-px` and paints the rail
  // as a 19px-wide filled block instead of a hairline.
  // `firstLinePad` is whatever padding the content column puts above its first
  // line: the title row has some, a prose body has none. The chip mirrors it so
  // both columns describe the same first line.
  const iconColumn = (firstLinePad: string) =>
    quietIcon ? (
      <div className="flex w-[19px] shrink-0 flex-col items-center" aria-hidden>
        <span className="w-px flex-1 bg-border" data-activity-rail />
      </div>
    ) : (
      <div className={cn("flex w-[19px] shrink-0 flex-col items-center", ICON_TOP_PAD)}>
        <span className={cn("flex items-center", COMPACT_LINE_BOX, firstLinePad)}>
          {/* Row chrome is deliberately tone-flat. The chip is a place for the
              glyph, not a signal of its own: whether the agent changed the book
              is carried by the verb and by the edits receipt, and jade in the
              timeline means one thing only, which is that something is a door. */}
          <span className="grid size-[19px] shrink-0 place-items-center rounded-md bg-chip-muted-bg text-ink-subtle">
            <Icon className="size-3" aria-hidden />
          </span>
        </span>
        <span className="mt-0.5 w-px flex-1 bg-border" data-activity-rail aria-hidden />
      </div>
    );

  // Prose layout: no title, just children. Side-by-side with the icon so a
  // multiline paragraph's first line aligns to the chip and subsequent lines
  // wrap under it (in the content column, never under the icon column).
  if (!title && children) {
    return (
      <div className="flex items-stretch gap-2.5" data-activity-row>
        {iconColumn("")}
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

  // The title row is the stretched area's positioning context. The toggle is
  // painted over the title content (later positioned sibling), and a door
  // inside the title lifts back above it with its own `z-10`.
  const titleRow = (
    <div
      className={cn(
        "relative -mx-1 flex items-start gap-2.5 rounded-md px-1",
        TITLE_ROW_PAD,
        hasInlineFold && "transition-colors hover:bg-muted",
      )}
    >
      {title ? (
        // No `overflow-hidden` here: a door inside grows past the line box to
        // reach a touch target, and clipping it would shrink that back down.
        // Each title renderer truncates its own content.
        <span id={titleId} className="min-w-0 flex-1 text-compact font-medium text-foreground">
          {title}
        </span>
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
      {hasInlineFold ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          // The toggle has no text of its own; the row's title names it.
          aria-labelledby={titleId}
          className="focus-ring absolute inset-0 cursor-pointer rounded-md"
        />
      ) : null}
    </div>
  );

  // Outer container is the flex row (icon column + content column). The
  // interactive area covers only the title row, not the icon column, because
  // the icon column owns the rail and the rail must extend through the row's
  // full height including any inline-fold body.
  return (
    <div className="flex items-stretch gap-2.5" data-activity-row>
      {iconColumn(TITLE_ROW_PAD)}
      <div className={cn("min-w-0 flex-1 pb-2", ICON_TOP_PAD)}>
        {titleRow}

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
              {/* Evaluated on open, not on render. */}
              <div className="mt-1.5">{open ? expand() : null}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
