/**
 * EditorContextPopover — Radix popover anchored to the current editor selection.
 *
 * Contextual editor controls share this positioning and focus behavior while
 * keeping their own commands and content local to the feature that needs them.
 */
import { type Editor, posToDOMRect } from "@tiptap/core";
import type { ComponentProps, ReactNode } from "react";
import { useRef } from "react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

type EditorContextPopoverProps = Omit<
  ComponentProps<typeof PopoverContent>,
  "children" | "onCloseAutoFocus"
> & {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

export function EditorContextPopover({
  editor,
  open,
  onOpenChange,
  children,
  ...contentProps
}: EditorContextPopoverProps) {
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const virtualAnchorRef = useRef({
    getBoundingClientRect() {
      const currentEditor = editorRef.current;
      if (currentEditor.isDestroyed) return new DOMRect();
      const { from, to } = currentEditor.state.selection;
      return posToDOMRect(currentEditor.view, from, to);
    },
  });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualAnchorRef} />
      <PopoverContent
        side="top"
        sideOffset={8}
        collisionPadding={8}
        updatePositionStrategy="always"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!editor.isDestroyed) editor.commands.focus();
        }}
        {...contentProps}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
