import type { ReactElement, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { TreeItemMenuItems } from "./TreeItemMenuItems";

export interface TreeMenuItemConfig {
  id: string;
  label: string;
  onSelect: () => void;
  variant?: "default" | "destructive";
  icon?: ReactNode;
  separator?: "before" | "after" | "both";
  disabled?: boolean;
  shortcut?: string;
}

interface TreeItemWithContextMenuProps {
  /**
   * Must be a single React element because Radix `asChild` uses `React.Children.only`.
   */
  children: ReactElement;
  menuItems: TreeMenuItemConfig[];
  /**
   * Optional hook to coordinate with other overlays (e.g. the "..." dropdown)
   * so we never show two menus at once.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Optional wrapper to inject between ContextMenuTrigger and children.
   * Useful for composing with HoverCardTrigger or other Radix primitives
   * that need to attach to the actual DOM element.
   */
  triggerWrapper?: (children: ReactElement) => ReactElement;
}

/**
 * Reusable wrapper that adds a context menu to any tree item.
 * Follows Open/Closed Principle - extend by passing different menu items.
 *
 * @example
 * <TreeItemWithContextMenu
 *   menuItems={[
 *     { id: 'rename', label: 'Rename', onSelect: handleRename },
 *     { id: 'delete', label: 'Delete', onSelect: handleDelete, variant: 'destructive', separator: 'before' }
 *   ]}
 * >
 *   <button>Tree Item Content</button>
 * </TreeItemWithContextMenu>
 */
export function TreeItemWithContextMenu({
  children,
  menuItems,
  onOpenChange,
  triggerWrapper,
}: TreeItemWithContextMenuProps) {
  // Apply wrapper if provided (e.g., HoverCardTrigger)
  const wrappedChildren = triggerWrapper ? triggerWrapper(children) : children;

  if (menuItems.length === 0) {
    return <>{wrappedChildren}</>;
  }

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{wrappedChildren}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <TreeItemMenuItems items={menuItems} variant="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
