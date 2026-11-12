import type { LucideIcon } from "lucide-react";
import { Fragment, type ReactElement, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  useMenuActionDispatch,
} from "./dropdown-menu";
import { OverflowMenu } from "./overflow-menu";

export type RowMenuItem = {
  id: string;
  label: ReactNode;
  icon: LucideIcon;
  destructive?: boolean;
};

/** An item, or a submenu of items. */
export type RowMenuEntry =
  | RowMenuItem
  | { id: string; label: ReactNode; icon: LucideIcon; items: readonly RowMenuItem[] };

/** A row's actions, drawn the same in its right-click menu and its ⋯. */
export type RowMenu = {
  /** Runs of entries, with a separator between runs. */
  groups: readonly (readonly RowMenuEntry[])[];
  /** Shown, disabled, in place of the groups: why nothing applies. */
  empty?: ReactNode;
  /** As either menu opens. */
  onOpen?: () => void;
  onSelect: (id: string) => void;
};

/** Right-click (and Shift+F10, the context-menu key, a long press) on `children` opens the menu. */
export function RowContextMenu({ menu, children }: { menu: RowMenu; children: ReactElement }) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  return (
    <ContextMenu onOpenChange={(open) => open && menu.onOpen?.()}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <MenuEntries
          menu={menu}
          parts={CONTEXT_PARTS}
          onSelect={(id) => dispatch(() => menu.onSelect(id))}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The row's ⋯: the same menu, from a button the row's height doesn't grow for. */
export function RowMenuButton({ menu, label }: { menu: RowMenu; label: string }) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  return (
    <OverflowMenu
      label={label}
      dense
      align="start"
      onOpenChange={(open) => open && menu.onOpen?.()}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <MenuEntries
        menu={menu}
        parts={DROPDOWN_PARTS}
        onSelect={(id) => dispatch(() => menu.onSelect(id))}
      />
    </OverflowMenu>
  );
}

type Parts = {
  Item: typeof ContextMenuItem | typeof DropdownMenuItem;
  Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
  Sub: typeof ContextMenuSub | typeof DropdownMenuSub;
  SubTrigger: typeof ContextMenuSubTrigger | typeof DropdownMenuSubTrigger;
  SubContent: typeof ContextMenuSubContent | typeof DropdownMenuSubContent;
};

const CONTEXT_PARTS: Parts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

const DROPDOWN_PARTS: Parts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

function MenuEntries({
  menu,
  parts: { Item, Separator, Sub, SubTrigger, SubContent },
  onSelect,
}: {
  menu: RowMenu;
  parts: Parts;
  onSelect: (id: string) => void;
}) {
  if (menu.empty) return <Item disabled>{menu.empty}</Item>;
  const item = ({ id, label, icon: Icon, destructive }: RowMenuItem) => (
    <Item
      key={id}
      data-variant={destructive ? "destructive" : "default"}
      onSelect={() => onSelect(id)}
    >
      <Icon aria-hidden className={destructive ? "size-3.5" : "size-3.5 text-muted-foreground"} />
      {label}
    </Item>
  );
  return menu.groups.map((group, index) => (
    <Fragment key={group[0]?.id ?? index}>
      {index > 0 ? <Separator /> : null}
      {group.map((entry) => {
        if (!("items" in entry)) return item(entry);
        const Icon = entry.icon;
        return (
          <Sub key={entry.id}>
            <SubTrigger>
              <Icon aria-hidden className="size-3.5 text-muted-foreground" />
              {entry.label}
            </SubTrigger>
            <SubContent>{entry.items.map(item)}</SubContent>
          </Sub>
        );
      })}
    </Fragment>
  ));
}
