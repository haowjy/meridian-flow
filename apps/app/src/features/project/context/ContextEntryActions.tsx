/** ContextEntryActions — right-click context menu and hover kebab button for file/folder rows in the desktop context tree. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, FolderInput, FolderPlus, type LucideIcon, Pencil, Trash2 } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Fragment, useCallback, useRef } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  dropdownMenuContentClass,
  dropdownMenuItemClass,
  dropdownMenuSeparatorClass,
  dropdownNavigationPageClass,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { cn } from "@/lib/utils";
import { contextTreeOverflowTriggerClassName } from "./context-row-geometry";

// ─── Action types ────────────────────────────────────────────────────────────

export type EntryAction = "new-file" | "new-folder" | "rename" | "move" | "delete";

type EntryActionSpec = {
  action: EntryAction;
  label: React.ReactNode;
  icon: LucideIcon;
  group: "create" | "manage";
  destructive?: true;
};

const ENTRY_ACTIONS: readonly EntryActionSpec[] = [
  { action: "new-file", label: <Trans>New file</Trans>, icon: FilePlus, group: "create" },
  { action: "new-folder", label: <Trans>New folder</Trans>, icon: FolderPlus, group: "create" },
  { action: "rename", label: <Trans>Rename</Trans>, icon: Pencil, group: "manage" },
  { action: "move", label: <Trans>Move…</Trans>, icon: FolderInput, group: "manage" },
  {
    action: "delete",
    label: <Trans>Delete</Trans>,
    icon: Trash2,
    group: "manage",
    destructive: true,
  },
];

export type EntryActionTarget = {
  /** Display name of the entry (basename). */
  name: string;
  /** Full scheme-relative path. */
  path: string;
} & ({ kind: "file"; documentId: string } | { kind: "dir"; entryId: string });

export type DeleteTarget = EntryActionTarget & {
  owner: ContextOwner;
  scheme: ProjectContextTreeScheme;
};

// ─── Right-click context menu (wraps the row) ───────────────────────────────

export function ContextEntryMenu({
  children,
  allowedActions,
  onAction,
}: {
  children: React.ReactNode;
  allowedActions: readonly EntryAction[];
  onAction: (action: EntryAction) => void;
}) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch(onAction);
  if (allowedActions.length === 0) return children;
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className={cn(
            dropdownNavigationPageClass,
            dropdownMenuContentClass,
            "origin-(--radix-context-menu-content-transform-origin) [--radix-menu-content-available-height:var(--radix-context-menu-content-available-height)]",
          )}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <ContextActionItems allowedActions={allowedActions} onAction={dispatch} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

function useMenuActionDispatch(onAction: (action: EntryAction) => void) {
  const pendingRef = useRef<EntryAction | null>(null);
  const dispatch = useCallback((action: EntryAction) => {
    pendingRef.current = action;
  }, []);
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      const action = pendingRef.current;
      if (action === null) return;
      pendingRef.current = null;
      event.preventDefault();
      onAction(action);
    },
    [onAction],
  );
  return { dispatch, onCloseAutoFocus };
}

// ─── Hover kebab button + dropdown ──────────────────────────────────────────

export function EntryKebabButton({
  allowedActions,
  onAction,
  className,
  align = "start",
  sideOffset = 2,
}: {
  allowedActions: readonly EntryAction[];
  onAction: (action: EntryAction) => void;
  className?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch(onAction);
  if (allowedActions.length === 0) return null;
  return (
    <OverflowMenu
      label={t`Actions`}
      align={align}
      sideOffset={sideOffset}
      onCloseAutoFocus={onCloseAutoFocus}
      triggerClassName={cn(contextTreeOverflowTriggerClassName, className)}
    >
      <DropdownActionItems allowedActions={allowedActions} onAction={dispatch} />
    </OverflowMenu>
  );
}

// ─── Primitive-specific renderers over the shared action specification ─────

function ContextActionItems({
  allowedActions,
  onAction,
}: {
  allowedActions: readonly EntryAction[];
  onAction: (action: EntryAction) => void;
}) {
  const actions = ENTRY_ACTIONS.filter((spec) => allowedActions.includes(spec.action));
  return (
    <>
      {actions.map((spec, index) => {
        const Icon = spec.icon;
        const startsGroup = index > 0 && actions[index - 1]?.group !== spec.group;
        return (
          <Fragment key={spec.action}>
            {startsGroup ? (
              <ContextMenuPrimitive.Separator className={dropdownMenuSeparatorClass} />
            ) : null}
            <ContextMenuPrimitive.Item
              data-variant={spec.destructive ? "destructive" : "default"}
              className={cn(dropdownRowVariants(), dropdownMenuItemClass)}
              onSelect={() => onAction(spec.action)}
            >
              <Icon
                className={cn("size-3.5", !spec.destructive && "text-muted-foreground")}
                aria-hidden
              />
              {spec.label}
            </ContextMenuPrimitive.Item>
          </Fragment>
        );
      })}
    </>
  );
}

function DropdownActionItems({
  allowedActions,
  onAction,
}: {
  allowedActions: readonly EntryAction[];
  onAction: (action: EntryAction) => void;
}) {
  const actions = ENTRY_ACTIONS.filter((spec) => allowedActions.includes(spec.action));
  return actions.map((spec, index) => {
    const Icon = spec.icon;
    const startsGroup = index > 0 && actions[index - 1]?.group !== spec.group;
    return (
      <Fragment key={spec.action}>
        {startsGroup ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          variant={spec.destructive ? "destructive" : "default"}
          onSelect={() => onAction(spec.action)}
        >
          <Icon
            className={cn("size-3.5", !spec.destructive && "text-muted-foreground")}
            aria-hidden
          />
          {spec.label}
        </DropdownMenuItem>
      </Fragment>
    );
  });
}
