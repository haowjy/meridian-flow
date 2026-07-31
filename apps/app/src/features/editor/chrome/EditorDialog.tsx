/**
 * EditorDialog — the lightbox an object opens over the still-mounted page
 * (Q1: never a route, never a takeover; the chapter stays visible behind the
 * scrim so the object's place in the document is seen rather than stated).
 *
 * It registers as a layer like every other surface, which is what makes law
 * 3's three-step walk fall out of one rule: a source pane inside the dialog
 * registers a layer of its own, so Esc closes the pane, then the dialog, then
 * leaves the object selected on the page.
 */

import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { KeymapBinding } from "@/core/editor/chrome";
import { cn } from "@/lib/utils";

import { useChromeLayer } from "./chrome-layers";

/**
 * How much screen a dialog is entitled to. The shell owns both numbers, so a
 * surface never has to out-specify them from its own stylesheet: a `form` is a
 * centered card that stops growing once its fields are readable, a `workspace`
 * is a frame whose only ceiling is the viewport, because the content in it — a
 * diagram on a pan/zoom canvas — is the reason the writer opened the dialog.
 * `svh` rather than `vh`: a phone's URL bar must not clip the header off.
 */
const DIALOG_SIZES = {
  form: "max-w-[min(64rem,92vw)]",
  workspace: "h-[88svh] w-[94vw] max-w-none",
} as const;

export type EditorDialogSize = keyof typeof DIALOG_SIZES;

export type EditorDialogProps = {
  editor: Editor | null;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read to assistive tech; visually hidden unless the surface shows it. */
  title: ReactNode;
  showTitle?: boolean;
  size?: EditorDialogSize;
  className?: string;
  /**
   * Keys the dialog answers while it is open, through the layer's own keyboard
   * path. Focus is inside portalled content here, where ProseMirror hears
   * nothing, so this is the route a dialog's shortcut takes instead of a
   * listener on the document.
   */
  keys?: Readonly<Record<string, KeymapBinding>>;
  children: ReactNode;
};

export function EditorDialog({
  editor,
  id,
  open,
  onOpenChange,
  title,
  showTitle = false,
  size = "form",
  className,
  keys,
  children,
}: EditorDialogProps) {
  // Radix carries its own Escape listener, so the kernel must not also
  // dismiss this one; `scope` is what lets a layer opened inside it — a
  // source pane — be recognised as the deeper one.
  const layer = useChromeLayer(editor, {
    id,
    open,
    close: () => onOpenChange(false),
    dismissal: "self",
    keys,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(DIALOG_SIZES[size], className)}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
      >
        <DialogTitle className={showTitle ? undefined : "sr-only"}>{title}</DialogTitle>
        {layer.scope(children)}
      </DialogContent>
    </Dialog>
  );
}
