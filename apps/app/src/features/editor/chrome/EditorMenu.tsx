/**
 * EditorMenu — the one menu every editor surface opens.
 *
 * Two anchorings, one component. A menu the writer summoned from a control
 * hangs off that control (`trigger`); a menu the context-menu router claimed
 * hangs off the pointer (`at`), through a zero-size anchor placed where the
 * click landed. Radix's DropdownMenu has no Anchor part, so that anchor is the
 * trigger — which is why anchoring lives here once instead of in six lanes.
 *
 * Radix is NOT wrapped away: it keeps ownership of dismissal, outside-click,
 * and roving focus (decision 2026-07-29). What this adds is subordination —
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
import { cn } from "@/lib/utils";
import { useChromeLayer } from "./chrome-layers";
import { pointerAnchorStyle } from "./pointer-anchor";
import { useReturnFocusToProse } from "./useEditorChrome";

export type EditorMenuProps = {
  editor: Editor | null;
  /** Names this surface in the Esc chain, e.g. `"link-menu"`. */
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Client coordinates for a menu the right-click router claimed. */
  at?: { x: number; y: number } | null;
  /** A control the writer pressed. Mutually exclusive with `at`. */
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
  const returnFocus = useReturnFocusToProse(editor);
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
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          // The pointer's own position, with no size and no hit area: it
          // exists to be measured, never pressed. Geometry rather than theme,
          // so it is inline style — a utility class that failed to ship would
          // silently drop the menu in the top-left corner.
          style={pointerAnchorStyle(at)}
        />
      )}
      <DropdownMenuContent
        align={align}
        side={side}
        // Approach chrome fades; a summoned menu does not need to be waited
        // for, so it keeps Radix's own entrance and nothing more.
        className={cn("min-w-52", className)}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
      >
        {layer.scope(children)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export {
  DropdownMenuCheckboxItem as EditorMenuCheckboxItem,
  DropdownMenuGroup as EditorMenuGroup,
  DropdownMenuItem as EditorMenuItem,
  DropdownMenuLabel as EditorMenuLabel,
  DropdownMenuRadioGroup as EditorMenuRadioGroup,
  DropdownMenuRadioItem as EditorMenuRadioItem,
  DropdownMenuSeparator as EditorMenuSeparator,
  DropdownMenuShortcut as EditorMenuShortcut,
  DropdownMenuSub as EditorMenuSub,
  DropdownMenuSubContent as EditorMenuSubContent,
  DropdownMenuSubTrigger as EditorMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
