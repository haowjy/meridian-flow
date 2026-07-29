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
import { cn } from "@/lib/utils";

import { useChromeLayer } from "./chrome-layers";

export type EditorDialogProps = {
  editor: Editor | null;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read to assistive tech; visually hidden unless the surface shows it. */
  title: ReactNode;
  showTitle?: boolean;
  className?: string;
  children: ReactNode;
};

export function EditorDialog({
  editor,
  id,
  open,
  onOpenChange,
  title,
  showTitle = false,
  className,
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
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("max-w-[min(64rem,92vw)]", className)}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
      >
        <DialogTitle className={showTitle ? undefined : "sr-only"}>{title}</DialogTitle>
        {layer.scope(children)}
      </DialogContent>
    </Dialog>
  );
}
