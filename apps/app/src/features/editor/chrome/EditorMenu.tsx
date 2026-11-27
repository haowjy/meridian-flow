/**
 * EditorMenu — the one menu every editor surface opens.
 *
 * Two anchorings, one component. A menu the writer summoned from a control
 * hangs off that control (`trigger`); a menu the context-menu router claimed
 * hangs off the pointer (`at`), through a one-pixel anchor placed where the
 * click landed. Radix's DropdownMenu has no Anchor part, so that anchor is the
 * trigger — which is why anchoring lives here once instead of in six lanes.
 *
 * Radix is NOT wrapped away: it keeps ownership of dismissal, outside-click,
 * and roving focus. What this adds is subordination —
 * the open menu registers as a layer so the Esc chain knows its place, and
 * every close path hands the caret back to the prose.
 *
 * `modal={false}` deliberately: a modal menu freezes the page behind it, and
 * the page behind it is the writer's chapter. Clicking away must land the
 * caret where they clicked, not just dismiss.
 */

import type { Editor } from "@tiptap/core";
import type { ComponentProps, ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChromeLayer } from "./chrome-layers";
import { pointerAnchorStyle } from "./pointer-anchor";

const REASON_DELAY_MS = 400;

export type EditorMenuProps = {
  editor: Editor | null;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  at?: { x: number; y: number } | null;
  trigger?: ReactNode;
  align?: ComponentProps<typeof DropdownMenuContent>["align"];
  side?: ComponentProps<typeof DropdownMenuContent>["side"];
  className?: string;
  children: ReactNode;
};

export function EditorMenu({
  editor,
  id,
  open,
  onOpenChange,
  at = null,
  trigger,
  align = "start",
  side,
  className,
  children,
}: EditorMenuProps) {
  // Radix carries its own Escape listener, so the kernel must not also
  // dismiss this one; `scope` is what lets a layer opened inside it — a
  // source pane — be recognised as the deeper one.
  const layer = useChromeLayer(editor, {
    id,
    open,
    close: () => onOpenChange(false),
    dismissal: "self",
  });

  // A pointer menu mounts once per opening. Kept mounted while closed, an
  // opening that lands inside the close animation reuses the closing content,
  // whose focus scope never takes focus again.
  if (!trigger && !open) return null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      {trigger ? (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger aria-hidden tabIndex={-1} style={pointerAnchorStyle(at)} />
      )}
      <DropdownMenuContent
        align={align}
        side={side}
        className={cn("min-w-52", className)}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
      >
        <TooltipProvider delayDuration={REASON_DELAY_MS}>{layer.scope(children)}</TooltipProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export {
  DropdownMenuLabel as EditorMenuLabel,
  DropdownMenuRadioGroup as EditorMenuRadioGroup,
  DropdownMenuRadioItem as EditorMenuRadioItem,
  DropdownMenuSeparator as EditorMenuSeparator,
  DropdownMenuSub as EditorMenuSub,
  DropdownMenuSubContent as EditorMenuSubContent,
  DropdownMenuSubTrigger as EditorMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
export {
  EditorMenuCheckboxItem,
  type EditorMenuCheckboxItemProps,
  EditorMenuItem,
  type EditorMenuItemProps,
} from "./EditorMenuItem";
export { ReasonTooltip, type ReasonTooltipProps } from "./ReasonTooltip";
