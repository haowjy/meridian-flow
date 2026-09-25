/** Renders a single process activity row in the transcript. */
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
  expand?: () => ReactNode;
  children?: ReactNode;
  /** Optional className applied to the prose container — for variant tinting. */
  proseClassName?: string;
};

const ICON_TOP_PAD = "pt-[3px]";

const TITLE_ROW_PAD = "py-0.5";

const COMPACT_LINE_BOX =
  // `box-content` so the min-height describes the line box itself, leaving the
  // content column's padding to be added on top of it exactly as the title row
  // adds it.
  "box-content min-h-[calc(var(--text-compact)*var(--text-compact--line-height))]";

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
        className="bg-status-live-foreground mt-[7px] size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
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
          className="focus-ring absolute inset-0 rounded-md"
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
