/**
 * SuggestionMenu — the list a writer types underneath, for `/` and for `[[`.
 *
 * The writer never leaves the sentence: focus stays in the prose, the query
 * they are typing IS the document text after the trigger, and this surface
 * only shows what the trigger has already matched. That is why nothing here is
 * focusable and why every row cancels its own mousedown — a menu that took
 * focus would stop the next keystroke from filtering.
 *
 * The keyboard is not here either. Arrow keys and Enter are registered against
 * the chrome kernel by whichever trigger opened the menu, at scope `layer`,
 * from the moment it opens; this component follows the highlight with the
 * scroll and renders it. Esc is the kernel's chain, reached by being an open
 * layer.
 *
 * A lane brings rows and reacts to a choice. Everything below — the eight-row
 * cap, the internal scroll, the hairline fades, the announcement the caret's
 * own element has to carry — is one behavior both menus share, so neither lane
 * can drift from the other on a Radix upgrade (§5.7's height ruling).
 *
 * A row a lane cannot take is shown greyed rather than hidden, with the reason
 * in `note` (law 5: absent beats disabled, disabled beats dead, and a writer
 * who cannot see why an entry refuses is left to wonder). It keeps the hover
 * and focus path — `aria-disabled`, never the `disabled` attribute — because
 * that is the path the reason travels.
 */

import type { Editor } from "@tiptap/core";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { EditorPopover } from "./EditorPopover";
import { useChromeSuppressed } from "./useEditorChrome";
import "./suggestion-menu.css";

export type SuggestionMenuRow = {
  /** Stable within one menu: the React key and the option's id. */
  key: string;
  /** A group heading or separator drawn above this row, when the lane wants one. */
  before?: ReactNode;
  /** Visible, greyed, and not choosable. `note` says why. */
  blocked?: boolean;
  content: ReactNode;
};

export type SuggestionMenuProps = {
  editor: Editor;
  /** Layer id, listbox id, and what a probe looks for. */
  id: string;
  open: boolean;
  /** What the listbox is offering, for a screen reader. */
  label: string;
  /** Read on every reposition: the trigger moves when the manuscript scrolls. */
  anchorRect: (() => DOMRect | null) | null;
  rows: readonly SuggestionMenuRow[];
  activeIndex: number;
  /** Hover moves the highlight; the keyboard owner is the trigger. */
  onActivate: (index: number) => void;
  onChoose: (index: number) => void;
  onDismiss: () => void;
  /**
   * Why rows are greyed, above them rather than below: the menu opens under
   * the caret, so its top edge is where the writer is already looking.
   */
  note?: ReactNode;
  className?: string;
};

/** Which edges have more list behind them, for the hairline fades. */
type Overflow = "none" | "top" | "bottom" | "both";

export function SuggestionMenu({
  editor,
  id,
  open,
  label,
  anchorRect,
  rows,
  activeIndex,
  onActivate,
  onChoose,
  onDismiss,
  note,
  className,
}: SuggestionMenuProps) {
  // Law: a surface stands down while a drag or sweep is in flight, without
  // guessing which gesture it was.
  const suppressed = useChromeSuppressed(editor);
  const shown = open && !suppressed;

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
  // children a commit after `open` flips, so an effect keyed on `open` runs
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
  useEffect(() => {
    if (!shown) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
    readOverflow();
  }, [shown, activeIndex, readOverflow]);

  const activeKey = rows[activeIndex]?.key;

  // Tells a screen reader what the caret's own element now controls. The prose
  // keeps focus, so the announcement has to travel from there.
  useEffect(() => {
    const prose = editor.isDestroyed ? null : editor.view.dom;
    if (!prose || !shown) return;
    prose.setAttribute("aria-expanded", "true");
    prose.setAttribute("aria-controls", id);
    if (activeKey) prose.setAttribute("aria-activedescendant", `${id}-${activeKey}`);
    return () => {
      prose.removeAttribute("aria-expanded");
      prose.removeAttribute("aria-controls");
      prose.removeAttribute("aria-activedescendant");
    };
  }, [editor, id, shown, activeKey]);

  return (
    <EditorPopover
      editor={editor}
      id={id}
      open={shown}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      anchorRect={anchorRect}
      align="start"
      side="bottom"
      focusOnOpen="prose"
      className={cn("meridian-suggestion-menu-shell min-w-64 p-0", className)}
    >
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
                id={`${id}-${row.key}`}
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
                // The caret is the writer's place in the chapter; a menu row
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
    </EditorPopover>
  );
}
