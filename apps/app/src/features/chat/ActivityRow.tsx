import type { LucideIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { DisclosureMark } from "@/components/ui/marks";
import { cn } from "@/lib/utils";

export type ActivityRowStatus = "running" | "done" | "error";

export type ActivityRowProps = {
  Icon: LucideIcon;
  quietIcon?: boolean;
  title?: ReactNode;
  status?: ActivityRowStatus;
  expand?: () => ReactNode;
  children?: ReactNode;
  proseClassName?: string;
};

const ICON_TOP_PAD = "pt-[3px]";

const TITLE_ROW_PAD = "py-0.5";

const COMPACT_LINE_BOX =
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
          <span className="grid size-[19px] shrink-0 place-items-center rounded-md bg-ink-fill text-muted-foreground">
            <Icon className="size-3" aria-hidden />
          </span>
        </span>
        <span className="mt-0.5 w-px flex-1 bg-border" data-activity-rail aria-hidden />
      </div>
    );

  if (!title && children) {
    return (
      <div className="flex items-stretch gap-[var(--chat-space-block)]" data-activity-row>
        {iconColumn("")}
        <div
          className={cn(
            "min-w-0 flex-1 text-compact text-muted-foreground",
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
        className="bg-muted-foreground mt-[var(--chat-row-status-center-offset)] size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
        aria-hidden
      />
    ) : status === "error" ? (
      <span
        className="mt-[var(--chat-row-status-center-offset)] size-1.5 shrink-0 rounded-full bg-destructive"
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
        "relative -mx-1 flex items-start gap-[var(--chat-space-block)] rounded-md px-1",
        TITLE_ROW_PAD,
      )}
    >
      {hasInlineFold ? (
        <DisclosureMark open={open} className="-mr-1 mt-[var(--chat-space-inline)]" />
      ) : null}
      {title ? (
        // No `overflow-hidden` here: a door inside grows past the line box to
        // reach a touch target, and clipping it would shrink that back down.
        // Each title renderer truncates its own content. The title sizes to its
        // text so the status dot and chevron sit beside it, not at the far edge.
        <span id={titleId} className="min-w-0 text-compact font-medium text-foreground">
          {title}
        </span>
      ) : null}
      {dot}
      {hasInlineFold ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
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
    <div className="flex items-stretch gap-[var(--chat-space-block)]" data-activity-row>
      {iconColumn(TITLE_ROW_PAD)}
      <div className={cn("min-w-0 flex-1", ICON_TOP_PAD)}>
        {titleRow}

        {title && children ? (
          <div
            className={cn(
              "mt-[var(--chat-space-inline)] text-compact text-muted-foreground",
              proseClassName,
            )}
          >
            {children}
          </div>
        ) : null}

        {hasInlineFold ? (
          <div
            id={panelId}
            className={cn(
              "grid transition-[grid-template-rows] ease-out",
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-w-0 overflow-hidden">
              <div className="mt-[var(--chat-space-inline)]">{open ? expand() : null}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
