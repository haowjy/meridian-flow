/**
 * EditorToolbar — formatting controls for document editors.
 *
 * Renders the TipTap/ProseMirror formatting commands as a bare control
 * cluster — no card chrome; `EditorSurfaceFrame` docks it in a prose-aligned
 * row above the scroll area. Subscribes to the editor's selection/transaction
 * events to keep active-mark highlighting in sync. Owns only command dispatch;
 * the image-upload button delegates back to `EditorView`.
 */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading1,
  ImageUp,
  Italic,
  List,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  type BlockAlignment,
  currentAlignableBlock,
  setCurrentBlockAlignment,
} from "./block-alignment";
import { LinkToolbarButton } from "./EditorLinkBubble";

export type EditorToolbarProps = {
  editor: Editor | null;
  onImageButtonClick?: () => void;
  imageUploadBusy?: boolean;
  imageUploadDisabled?: boolean;
  linkBubbleOpen?: boolean;
  linkBubbleId?: string;
  onOpenLinkBubble?: () => void;
};

export function EditorToolbar({
  editor,
  onImageButtonClick,
  imageUploadBusy = false,
  imageUploadDisabled = false,
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
        <AlignmentControl editor={editor} />
        <ToolbarButton
          label={t`Insert image`}
          disabled={!editor || imageUploadBusy || imageUploadDisabled}
          onClick={() => onImageButtonClick?.()}
        >
          <ImageUp className="size-3.5" aria-hidden />
        </ToolbarButton>
      </div>
    </div>
  );
}

type AlignmentControlValue = "default" | Exclude<BlockAlignment, null>;

function AlignmentControl({ editor }: { editor: Editor | null }) {
  const block = editor ? currentAlignableBlock(editor.state) : null;
  const value: AlignmentControlValue =
    block?.node.attrs.align === "center" || block?.node.attrs.align === "right"
      ? block.node.attrs.align
      : "default";
  const Icon = value === "center" ? AlignCenter : value === "right" ? AlignRight : AlignLeft;

  const setAlignment = (next: string) => {
    if (!editor || !block) return;
    const align = next === "center" || next === "right" ? next : null;
    const transaction = setCurrentBlockAlignment(editor.state, align);
    if (transaction) editor.view.dispatch(transaction);
    editor.commands.focus();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t`Block alignment`}
          disabled={!block}
          className={cn(value !== "default" && "bg-primary/10 text-primary hover:text-primary")}
        >
          <Icon className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={setAlignment}>
          <DropdownMenuRadioItem value="default">
            <AlignLeft aria-hidden />
            {t`Default alignment`}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="center">
            <AlignCenter aria-hidden />
            {t`Center`}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="right">
            <AlignRight aria-hidden />
            {t`Right`}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
