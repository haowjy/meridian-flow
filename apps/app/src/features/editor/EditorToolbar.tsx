/**
 * EditorToolbar — formatting controls for document editors.
 *
 * Renders the TipTap/ProseMirror formatting commands as a bare control
 * cluster — no card chrome; `EditorSurfaceFrame` docks it in a prose-aligned
 * row above the scroll area. Subscribes to the editor's selection/transaction
 * events to keep active-mark highlighting in sync. Owns only command dispatch;
 * the figure-upload button delegates back to `EditorView` via
 * `onFigureButtonClick`.
 */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Bold, Code, Heading1, ImageUp, Italic, List } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LinkToolbarButton } from "./EditorLinkBubble";

export type EditorToolbarProps = {
  editor: Editor | null;
  onFigureButtonClick?: () => void;
  figureUploadBusy?: boolean;
  figureUploadDisabled?: boolean;
  linkBubbleOpen?: boolean;
  linkBubbleId?: string;
  onOpenLinkBubble?: () => void;
};

export function EditorToolbar({
  editor,
  onFigureButtonClick,
  figureUploadBusy = false,
  figureUploadDisabled = false,
  linkBubbleOpen = false,
  linkBubbleId = "editor-link-bubble",
  onOpenLinkBubble,
}: EditorToolbarProps) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setVersion((v) => v + 1);
    editor.on("selectionUpdate", bump);
    editor.on("transaction", bump);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("transaction", bump);
    };
  }, [editor]);

  return (
    <div
      className="flex w-auto min-w-0 items-center gap-1"
      role="toolbar"
      aria-label={t`Editor formatting toolbar`}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <ToolbarButton
          label={t`Heading`}
          active={editor?.isActive("heading", { level: 1 }) ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Bold`}
          active={editor?.isActive("strong") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Italic`}
          active={editor?.isActive("em") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Code`}
          active={editor?.isActive("code") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Bullet list`}
          active={editor?.isActive("bullet_list") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="size-3.5" aria-hidden />
        </ToolbarButton>
        <LinkToolbarButton
          editor={editor}
          bubbleOpen={linkBubbleOpen}
          bubbleId={linkBubbleId}
          onOpen={() => onOpenLinkBubble?.()}
        />
        <ToolbarButton
          label={t`Upload figure`}
          disabled={!editor || figureUploadBusy || figureUploadDisabled}
          onClick={() => onFigureButtonClick?.()}
        >
          <ImageUp className="size-3.5" aria-hidden />
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && "bg-primary/10 text-primary hover:text-primary")}
    >
      {children}
    </Button>
  );
}
