/** Shared docked-toolbar and scrolling layout for document editor surfaces. */
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import type { MouseEvent as ReactMouseEvent, ReactNode, Ref, UIEventHandler } from "react";

import { cn } from "@/lib/utils";
import { editorColumnChrome } from "./editor-column";

export type EditorSurfaceFrameProps = {
  toolbar?: ReactNode;
  children: ReactNode;
  /**
   * When given, the whole scroll area becomes click-to-focus territory: a
   * press on the gutters or wrapper padding (outside the ProseMirror node)
   * places the caret at the nearest text position, like clicking the page
   * margin in a word processor (user call 2026-07-16 — the editor pane must
   * not have click-dead margins).
   */
  editor?: Editor | null;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

function focusEditorFromGutterPress(editor: Editor, event: ReactMouseEvent<HTMLDivElement>) {
  const frame = event.currentTarget;
  const frameRect = frame.getBoundingClientRect();
  // clientWidth excludes a native scrollbar — presses in the scrollbar strip
  // must keep their default behavior.
  if (event.clientX - frameRect.left >= frame.clientWidth) return;

  const prose = editor.view.dom.getBoundingClientRect();
  const pos = editor.view.posAtCoords({
    left: Math.min(Math.max(event.clientX, prose.left + 1), prose.right - 1),
    top: Math.min(Math.max(event.clientY, prose.top + 1), prose.bottom - 1),
  });
  // Focusing on mousedown (not click) matches ProseMirror's own timing;
  // preventDefault stops the press from re-blurring the editor it just focused.
  event.preventDefault();
  if (!pos) {
    editor.commands.focus("end");
    return;
  }
  // posAtCoords in the inter-paragraph gap returns a block-boundary position;
  // fed raw to focus() it parks the selection at doc level — remote collab
  // cursors then render BETWEEN <p>s as a phantom uneditable row. near()
  // always resolves into the adjacent textblock.
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos.pos))));
  view.focus();
}

export function EditorSurfaceFrame({
  toolbar,
  children,
  editor,
  scrollClassName,
  scrollRef,
  onScroll,
}: EditorSurfaceFrameProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar ? (
        <div className="flex h-9 shrink-0 items-center">
          <div className={editorColumnChrome}>{toolbar}</div>
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the mousedown is
          pointer-only caret delegation into the editor (page-margin clicks);
          keyboard users reach the same editor via Tab focus on the prose node. */}
      <div
        ref={scrollRef}
        // flex-col so canvas children can take the editorColumnFill chain —
        // the prose node must fill the scroll area for click-below-text focus.
        // cursor-text: the whole scroll area is caret territory when an editor
        // is attached — the cursor must promise what the press delivers.
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          editor && "cursor-text",
          scrollClassName,
        )}
        data-stable-layout-scroll
        onScroll={onScroll}
        onMouseDown={
          editor
            ? (event) => {
                if (event.button !== 0 || event.defaultPrevented || editor.isDestroyed) return;
                // The hijack covers inert gutter layout only: ProseMirror owns
                // presses in the prose ([contenteditable]), and interactive or
                // live-status children ([role], controls) keep native behavior
                // — including selectable text in upload error messages. The
                // closest() match only counts INSIDE the scroller: ancestors
                // (the pane's tabpanel role, etc.) must not veto gutter presses.
                const match = (event.target as Element).closest(
                  "[contenteditable], [role], a, button, input, textarea, select",
                );
                if (match && event.currentTarget.contains(match)) return;
                focusEditorFromGutterPress(editor, event);
              }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
