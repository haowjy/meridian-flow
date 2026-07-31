/**
 * SuggestionMenu — the manuscript's half of a typed-under menu, for `/` and
 * for `[[`.
 *
 * The rows, their scroll, the fades, and the listbox semantics are
 * [`SuggestionList`](../../../components/app/SuggestionList.tsx), shared with
 * the chat composer's `@`. What this adds is everything true only inside the
 * editor: the chrome kernel's popover and Esc chain, standing down while a
 * drag or sweep is in flight, and telling a screen reader that the caret's own
 * element now controls a listbox — the prose keeps focus, so the announcement
 * has to travel from there.
 *
 * The keyboard is not here either. Arrow keys and Enter are registered against
 * the chrome kernel by whichever trigger opened the menu, at scope `layer`,
 * from the moment it opens, so the first ArrowDown cannot miss.
 */

import type { Editor } from "@tiptap/core";
import { type ReactNode, useEffect } from "react";

import {
  SUGGESTION_MENU_SHELL,
  SuggestionList,
  type SuggestionListRow,
  suggestionOptionId,
} from "@/components/app/SuggestionList";
import { cn } from "@/lib/utils";

import { EditorPopover } from "./EditorPopover";
import { useChromeSuppressed } from "./useEditorChrome";

export type SuggestionMenuRow = SuggestionListRow;

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

  const activeKey = rows[activeIndex]?.key;

  // Tells a screen reader what the caret's own element now controls. The prose
  // keeps focus, so the announcement has to travel from there.
  useEffect(() => {
    const prose = editor.isDestroyed ? null : editor.view.dom;
    if (!prose || !shown) return;
    prose.setAttribute("aria-expanded", "true");
    prose.setAttribute("aria-controls", id);
    if (activeKey) prose.setAttribute("aria-activedescendant", suggestionOptionId(id, activeKey));
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
      className={cn(SUGGESTION_MENU_SHELL, "min-w-64 p-0", className)}
    >
      <SuggestionList
        id={id}
        label={label}
        rows={rows}
        activeIndex={activeIndex}
        onActivate={onActivate}
        onChoose={onChoose}
        note={note}
      />
    </EditorPopover>
  );
}
