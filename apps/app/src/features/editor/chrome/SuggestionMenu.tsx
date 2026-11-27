/**
 * SuggestionMenu — the list a writer types underneath, for `/` and for `@`.
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
 * cap, the internal scroll, the fades on the list's own edges, the
 * announcement the caret's own element has to carry — is one behavior both
 * menus share, so neither lane can drift from the other on a Radix upgrade
 * (§5.7's height rule).
 */

import type { Editor } from "@tiptap/core";
import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { dropdownPanelClass, dropdownRowVariants } from "@/components/ui/dropdown-presentation";
import { withRowNote } from "@/components/ui/marks";
import { cn } from "@/lib/utils";

import { EditorPopover } from "./EditorPopover";
import { useChromeSuppressed } from "./useEditorChrome";
import "./suggestion-menu.css";

export type SuggestionMenuRow = {
  key: string;
  before?: ReactNode;
  content: ReactNode;
  note?: ReactNode;
  opens?: boolean;
};

export type SuggestionMenuProps = {
  editor: Editor;
  typingElement: HTMLElement;
  id: string;
  open: boolean;
  label: string;
  anchorRect: (() => DOMRect | null) | null;
  rows: readonly SuggestionMenuRow[];
  activeIndex: number;
  onActivate: (index: number) => void;
  onChoose: (index: number) => void;
  onDismiss: () => void;
  header?: ReactNode;
  empty?: ReactNode;
  className?: string;
  side?: "top" | "bottom";
};

type Overflow = "none" | "top" | "bottom" | "both";

export function SuggestionMenu({
  editor,
  typingElement,
  id,
  open,
  label,
  anchorRect,
  rows,
  activeIndex,
  onActivate,
  onChoose,
  onDismiss,
  header,
  empty,
  className,
  side = "bottom",
}: SuggestionMenuProps) {
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
  // `rows` is a dependency because the writer is still typing: a query that
  // narrows twenty rows to three shortens the list without touching the
  // highlight, and a fade left behind would promise items that no longer exist.
  useEffect(() => {
    if (!shown) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
    readOverflow();
  }, [shown, activeIndex, rows, readOverflow]);

  const activeKey = rows[activeIndex]?.key;

  useEffect(() => {
    if (!shown) return;
    typingElement.setAttribute("aria-expanded", "true");
    typingElement.setAttribute("aria-controls", id);
    if (activeKey) typingElement.setAttribute("aria-activedescendant", `${id}-${activeKey}`);
    return () => {
      typingElement.removeAttribute("aria-expanded");
      typingElement.removeAttribute("aria-controls");
      typingElement.removeAttribute("aria-activedescendant");
    };
  }, [id, shown, activeKey, typingElement]);

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
      side={side}
      focusOnOpen="prose"
      returnFocus={() => typingElement.focus()}
      className={cn(dropdownPanelClass, "meridian-suggestion-menu-shell min-w-64 p-0", className)}
    >
      {header ? (
        <div className="border-border-subtle border-b px-2 py-1.5 text-muted-foreground text-xs">
          {header}
        </div>
      ) : null}
      <div
        ref={attachScroller}
        onScroll={readOverflow}
        id={id}
        role="listbox"
        aria-label={label}
        data-overflow={overflow}
        hidden={rows.length === 0 && Boolean(empty)}
        className="meridian-suggestion-menu p-1.5"
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
                ref={active ? activeRef : undefined}
                tabIndex={-1}
                className={cn(
                  dropdownRowVariants({ interactive: false }),
                  active && "bg-ink-fill",
                  "cursor-default [&_svg]:text-muted-foreground",
                )}
                // The caret is the writer's place in the chapter; a menu row
                // taking focus from it would end the filter mid-word.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onActivate(index)}
                onClick={() => onChoose(index)}
              >
                {withRowNote(
                  row.content,
                  row.note,
                  row.opens ? <ChevronRight aria-hidden /> : null,
                )}
              </button>
            </Fragment>
          );
        })}
      </div>
      {rows.length === 0 && empty ? <div className="p-1.5">{empty}</div> : null}
    </EditorPopover>
  );
}
