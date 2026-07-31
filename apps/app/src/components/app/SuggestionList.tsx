/**
 * SuggestionList — the rows a writer types underneath, in whatever is holding
 * them.
 *
 * Three triggers render this: `/` and `[[` in the manuscript, and `@` in the
 * chat composer. What they share is not a popover — the editor's
 * opens through the chrome kernel and the composer's does not — but the list
 * inside one: the eight-row cap, the internal scroll, the fades on its own
 * edges, the highlight following the arrow keys, and the listbox semantics a
 * screen reader reads. One implementation is what keeps the two from drifting
 * apart on the next Radix upgrade.
 *
 * **The keyboard is not here.** Arrow keys and Enter are registered by whoever
 * opened the menu, from the moment it opens, because the first ArrowDown after
 * a trigger cannot afford to wait for React. This follows the highlight and
 * renders it.
 *
 * **Nothing here is focusable and every row cancels its own mousedown.** The
 * writer's caret is in the prose or in the composer; a menu that took focus
 * would stop the next keystroke from filtering.
 *
 * A row a host cannot take is shown greyed rather than hidden, with the reason
 * above the list (law 5: absent beats disabled, disabled beats dead, and a
 * writer who cannot see why an entry refuses is left to wonder). It keeps the
 * hover and focus path — `aria-disabled`, never the `disabled` attribute —
 * because that is the path the reason travels.
 */

import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import "./suggestion-menu.css";

/**
 * The surface class a host's popover wears: it clips the list to its own
 * corners and never asks for more room than the caret leaves it.
 */
export const SUGGESTION_MENU_SHELL = "meridian-suggestion-menu-shell";

export type SuggestionListRow = {
  /** Stable within one menu: the React key and the option's id. */
  key: string;
  /** A group heading or separator drawn above this row, when the host wants one. */
  before?: ReactNode;
  /** Visible, greyed, and not choosable. `note` says why. */
  blocked?: boolean;
  content: ReactNode;
};

export type SuggestionListProps = {
  /** Listbox id, the prefix every option id carries, and what a probe looks for. */
  id: string;
  /** What the listbox is offering, for a screen reader. */
  label: string;
  rows: readonly SuggestionListRow[];
  activeIndex: number;
  /** Hover moves the highlight; the keyboard owner is the trigger. */
  onActivate: (index: number) => void;
  onChoose: (index: number) => void;
  /**
   * Why rows are greyed, above them rather than below: the menu opens under
   * the caret, so its top edge is where the writer is already looking.
   */
  note?: ReactNode;
};

/** Which of the scroller's own edges have more list behind them, for its fades. */
type Overflow = "none" | "top" | "bottom" | "both";

/** The id an option carries, so a host can name the active one out loud. */
export function suggestionOptionId(id: string, key: string): string {
  return `${id}-${key}`;
}

export function SuggestionList({
  id,
  label,
  rows,
  activeIndex,
  onActivate,
  onChoose,
  note,
}: SuggestionListProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");

  const readOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const above = scroller.scrollTop > 1;
    const below = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    setOverflow(above && below ? "both" : above ? "top" : below ? "bottom" : "none");
  }, []);

  // Measured from the ref callback, not an effect: Radix mounts the portal's
  // children a commit after `open` flips, so an effect keyed on mounting runs
  // while there is nothing to measure and the fades never appear.
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      if (node) readOverflow();
    },
    [readOverflow],
  );

  // The scroll follows the arrow keys (ruled), and `nearest` plus the
  // scroller's own scroll padding keeps the highlighted row clear of the fade.
  // `rows` is a dependency because the writer is still typing: a query that
  // narrows twenty rows to three shortens the list without touching the
  // highlight, and a fade left behind would promise items that no longer exist.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
    readOverflow();
  }, [activeIndex, rows, readOverflow]);

  return (
    <>
      {note ? (
        <div className="border-border-subtle border-b px-2 py-1.5 text-ink-subtle text-xs">
          {note}
        </div>
      ) : null}
      <div
        ref={attachScroller}
        onScroll={readOverflow}
        id={id}
        role="listbox"
        aria-label={label}
        data-overflow={overflow}
        className="meridian-suggestion-menu p-1"
      >
        {rows.map((row, index) => {
          const active = index === activeIndex;
          return (
            <Fragment key={row.key}>
              {row.before}
              <button
                type="button"
                role="option"
                id={suggestionOptionId(id, row.key)}
                aria-selected={active}
                aria-disabled={row.blocked || undefined}
                ref={active ? activeRef : undefined}
                tabIndex={-1}
                className={cn(
                  "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                  active && "bg-accent text-accent-foreground",
                  row.blocked && "text-muted-foreground",
                )}
                // The caret is the writer's place in the sentence; a menu row
                // taking focus from it would end the filter mid-word.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!row.blocked) onActivate(index);
                }}
                onClick={() => {
                  if (!row.blocked) onChoose(index);
                }}
              >
                {row.content}
              </button>
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
