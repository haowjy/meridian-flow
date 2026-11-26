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

  return (
    // A pointer menu summoned at a new point is a NEW menu. Radix positions
    // against the anchor through floating-ui's `autoUpdate`, which watches for
    // resizes and scrolls — moving a fixed anchor by changing its `left` is
    // invisible to it, so a re-open without a remount lands where the last one
    // did. The key is the fix; repositioning by hand would be a second
    // positioning system beside the library's.
    <DropdownMenu
      key={at ? `${at.x},${at.y}` : "trigger"}
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
    >
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
