import { Fragment } from "react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "./ui/dropdown-menu";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import type { TreeMenuItemConfig } from "./TreeItemWithContextMenu";

type MenuVariant = "dropdown" | "context";

interface TreeItemMenuItemsProps {
  items: TreeMenuItemConfig[];
  variant: MenuVariant;
}

export function TreeItemMenuItems({ items, variant }: TreeItemMenuItemsProps) {
  const Separator =
    variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const Shortcut =
    variant === "context" ? ContextMenuShortcut : DropdownMenuShortcut;

  return (
    <>
      {items.map((item, index) => {
        const showSeparatorBefore =
          item.separator === "before" || item.separator === "both";
        const showSeparatorAfter =
          item.separator === "after" || item.separator === "both";

        return (
          <Fragment key={item.id}>
            {showSeparatorBefore && index > 0 && <Separator />}
            <Item
              onSelect={item.onSelect}
              variant={item.variant}
              disabled={item.disabled}
            >
              {item.icon && <span className="mr-2">{item.icon}</span>}
              <span>{item.label}</span>
              {item.shortcut && <Shortcut>{item.shortcut}</Shortcut>}
            </Item>
            {showSeparatorAfter && index < items.length - 1 && <Separator />}
          </Fragment>
        );
      })}
    </>
  );
}
