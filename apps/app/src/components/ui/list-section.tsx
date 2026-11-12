import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DisclosureMark } from "./marks";
import { role } from "./roles";

export type SectionFold = { open: boolean; onToggle: (open: boolean) => void };

/**
 * The name above a list or a group of its rows, the one heading every sidebar list uses, as tall
 * as a row. A plain heading's text, and a fold's leading chevron, sit on the rows' text edge.
 * Actions show on hover or focus (`.rail-pane-actions`, globals.css).
 */
export function ListSectionHeader({
  label,
  level = 3,
  title,
  fold,
  foldedMark,
  actions,
  headerProps,
}: {
  label: string;
  level?: 2 | 3;
  /** Tooltip and accessible name, for a list whose full name is longer than its label. */
  title?: string;
  fold?: SectionFold;
  /** Shown after a folded heading's label: what its hidden rows would say. */
  foldedMark?: ReactNode;
  actions?: ReactNode;
  /** Drop handlers when the heading is a drop target. */
  headerProps?: HTMLAttributes<HTMLElement>;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const look = level === 2 ? role.groupLabel : role.subgroupLabel;
  const name = <span className="min-w-0 truncate">{label}</span>;
  return (
    <div {...headerProps} data-rail-pane-header className="mx-2 flex min-h-7 shrink-0 items-center">
      <Heading
        title={title}
        aria-label={fold ? undefined : title}
        className={cn(
          "flex min-w-0 flex-1 items-center self-stretch",
          !fold && "pr-1 pl-1.5",
          look,
        )}
      >
        {fold ? (
          // The whole heading row folds, its box the rows' box, so its focus ring lines up with
          // theirs. No hover fill: hover darkens the label.
          <button
            type="button"
            aria-expanded={fold.open}
            aria-label={title}
            onClick={() => fold.onToggle(!fold.open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") fold.onToggle(false);
              if (event.key === "ArrowRight") fold.onToggle(true);
            }}
            className={cn(
              "focus-ring flex min-w-0 flex-1 items-center gap-1 self-stretch rounded-md px-1.5 text-left transition-colors hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none coarse:min-h-11",
              // Preflight resets a button's text-transform; the label's case needs restating.
              look,
            )}
          >
            <span className="flex w-3 shrink-0 justify-center">
              <DisclosureMark open={fold.open} />
            </span>
            {name}
            {fold.open ? null : foldedMark}
          </button>
        ) : (
          name
        )}
      </Heading>
      {actions ? (
        <span className="rail-pane-actions mr-2 flex shrink-0 items-center gap-1 [&>*]:transition-opacity">
          {actions}
        </span>
      ) : null}
    </div>
  );
}

/** A heading and its rows, inset like every list's rows; a folded section shows its heading alone. */
export function ListSection({
  children,
  ...header
}: Parameters<typeof ListSectionHeader>[0] & { children: ReactNode }) {
  return (
    <section aria-label={header.label} className="pt-2">
      <ListSectionHeader {...header} />
      {header.fold && !header.fold.open ? null : <div className="px-2">{children}</div>}
    </section>
  );
}
