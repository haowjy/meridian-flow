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
