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
import { Bold, Code, Heading1, ImageUp, Italic, Link, List, Unlink } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EditorContextPopover } from "./EditorContextPopover";
import { linkAttributesAtSelection } from "./link-selection";
import { normalizeLinkHref } from "./link-url";

export type EditorToolbarProps = {
  editor: Editor | null;
  onFigureButtonClick?: () => void;
  figureUploadBusy?: boolean;
  figureUploadDisabled?: boolean;
};

export function EditorToolbar({
  editor,
  onFigureButtonClick,
  figureUploadBusy = false,
  figureUploadDisabled = false,
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
        <LinkControl editor={editor} />
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

function LinkControl({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const [editingExistingLink, setEditingExistingLink] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const popoverId = `${inputId}-popover`;

  const activeLink = editor ? linkAttributesAtSelection(editor) : null;
  const active = Boolean(activeLink);
  const canOpen = Boolean(editor && (!editor.state.selection.empty || active));

  const openPopover = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    const currentLink = linkAttributesAtSelection(editor);
    if (editor.state.selection.empty && !currentLink) return;

    setHref(String(currentLink?.href ?? ""));
    setEditingExistingLink(Boolean(currentLink));
    setInvalid(false);
    setOpen(true);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      if (editor.state.selection.empty && !linkAttributesAtSelection(editor)) return;
      event.preventDefault();
      openPopover();
    };
    editor.view.dom.addEventListener("keydown", handleShortcut);
    return () => editor.view.dom.removeEventListener("keydown", handleShortcut);
  }, [editor, openPopover]);

  if (!editor) {
    return (
      <ToolbarButton label={t`Link`} disabled onClick={() => {}}>
        <Link className="size-3.5" aria-hidden />
      </ToolbarButton>
    );
  }

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(false);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedHref = normalizeLinkHref(href);

    if (!href.trim() && editingExistingLink) {
      removeLink();
      return;
    }
    if (!normalizedHref) {
      setInvalid(true);
      return;
    }

    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: normalizedHref, title: null })
      .run();
    setOpen(false);
  };

  const handlePopoverKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    editor.commands.focus();
  };

  return (
    <>
      <ToolbarButton
        label={t`Link`}
        active={active}
        disabled={!canOpen}
        popupOpen={open}
        popupControls={popoverId}
        onClick={openPopover}
      >
        <Link className="size-3.5" aria-hidden />
      </ToolbarButton>
      <EditorContextPopover
        editor={editor}
        open={open}
        onOpenChange={setOpen}
        align="center"
        className="w-80 p-2"
        id={popoverId}
        aria-label={t`Edit link`}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <form
          className="flex items-start gap-1.5"
          onSubmit={submit}
          onKeyDown={handlePopoverKeyDown}
        >
          <div className="min-w-0 flex-1">
            <label className="visually-hidden" htmlFor={inputId}>
              {t`Link URL`}
            </label>
            <Input
              ref={inputRef}
              id={inputId}
              type="text"
              inputMode="url"
              value={href}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              placeholder={t`Paste or type a link`}
              className="h-8"
              onChange={(event) => {
                setHref(event.target.value);
                setInvalid(false);
              }}
            />
            {invalid ? (
              <p id={errorId} className="px-1 pt-1 text-destructive text-xs" role="alert">
                {t`Enter an http, https, or mailto link.`}
              </p>
            ) : null}
          </div>
          <Button type="submit" size="sm" className="h-8">
            {editingExistingLink ? t`Update link` : t`Add link`}
          </Button>
          {editingExistingLink ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8"
              aria-label={t`Remove link`}
              onClick={removeLink}
            >
              <Unlink className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </form>
      </EditorContextPopover>
    </>
  );
}

function ToolbarButton({
  label,
  active,
  disabled,
  popupOpen,
  popupControls,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  popupOpen?: boolean;
  popupControls?: string;
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
      aria-haspopup={popupControls ? "dialog" : undefined}
      aria-expanded={popupControls ? popupOpen : undefined}
      aria-controls={popupControls}
      data-state={popupControls ? (popupOpen ? "open" : "closed") : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && "bg-primary/10 text-primary hover:text-primary")}
    >
      {children}
    </Button>
  );
}
