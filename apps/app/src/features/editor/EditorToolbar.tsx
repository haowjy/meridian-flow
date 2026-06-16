/**
 * EditorToolbar — formatting controls for the document editor.
 *
 * Renders the TipTap/ProseMirror command bar (bold, italic, code, heading,
 * list, link, table, math, figure upload) above `EditorView`. Subscribes to the
 * editor's selection/transaction events to keep active-mark highlighting in
 * sync. Owns only the toolbar chrome and command dispatch; the figure-upload
 * button delegates back to `EditorView` via `onFigureButtonClick`.
 *
 * Generic by design: the optional `leading` slot lets callers (today: the
 * context layer's per-variant `FilesToggle`) inject controls before the
 * formatting cluster without this module knowing what they are.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Editor, JSONContent } from "@tiptap/core";
import {
  Bold,
  Code,
  FunctionSquare,
  Heading1,
  ImageUp,
  Italic,
  Link,
  List,
  Table2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function tableContent(): JSONContent {
  return {
    type: "table",
    content: [
      {
        type: "table_row",
        content: [
          {
            type: "table_header",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: "text", text: "A" }],
          },
          {
            type: "table_header",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: "text", text: "B" }],
          },
        ],
      },
      {
        type: "table_row",
        content: [
          {
            type: "table_cell",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: "text", text: "1" }],
          },
          {
            type: "table_cell",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: "text", text: "2" }],
          },
        ],
      },
    ],
  };
}

export type EditorToolbarProps = {
  editor: Editor | null;
  onFigureButtonClick?: () => void;
  figureUploadBusy?: boolean;
  figureUploadDisabled?: boolean;
  /**
   * Optional leading slot rendered before the formatting controls. The
   * editor stays unaware of what goes here — the context layer threads its
   * per-variant "files toggle" through this slot. A thin divider follows
   * the slot when present so the formatting cluster reads as its own group.
   */
  leading?: ReactNode;
};

export function EditorToolbar({
  editor,
  onFigureButtonClick,
  figureUploadBusy = false,
  figureUploadDisabled = false,
  leading,
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
      className="flex w-full min-w-0 items-center gap-1"
      role="toolbar"
      aria-label={t`Editor formatting toolbar`}
    >
      {leading ? (
        <>
          <div className="flex shrink-0 items-center">{leading}</div>
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        </>
      ) : null}
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
        <ToolbarButton
          label={t`Link`}
          disabled={!editor}
          onClick={() =>
            editor
              ?.chain()
              .focus()
              .setMark("link", { href: "https://meridian.bio", title: null })
              .run()
          }
        >
          <Link className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Math block`}
          disabled={!editor}
          onClick={() =>
            editor
              ?.chain()
              .focus()
              .insertContent({
                type: "math_display",
                content: [{ type: "text", text: "E = mc^2" }],
              })
              .run()
          }
        >
          <FunctionSquare className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Table`}
          disabled={!editor}
          onClick={() => editor?.chain().focus().insertContent(tableContent()).run()}
        >
          <Table2 className="size-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t`Upload figure`}
          disabled={!editor || figureUploadBusy || figureUploadDisabled}
          onClick={() => onFigureButtonClick?.()}
        >
          <ImageUp className="size-3.5" aria-hidden />
        </ToolbarButton>
      </div>
      <span className="ml-2 hidden min-w-0 flex-1 truncate text-fine text-muted-foreground md:inline">
        <Trans>/figure…</Trans>
      </span>
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
