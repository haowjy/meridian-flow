/** ContextEntryActions — right-click context menu and hover kebab button for file/folder rows in the desktop context tree. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  ChevronRight,
  Copy,
  FilePlus,
  Files,
  Folder,
  FolderInput,
  FolderPlus,
  ImportIcon,
  type LucideIcon,
  Pencil,
  Trash2,
} from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Fragment, useCallback, useRef } from "react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
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

export type EntryAction =
  | "new-file"
  | "new-folder"
  | "import-folder"
  | "import-files"
  | "rename"
  | "move"
  | "copy"
  | "delete";

type EntryActionSpec = {
  action: EntryAction;
  label: React.ReactNode;
  icon: LucideIcon;
  group: "create" | "manage";
  destructive?: true;
  inImportMenu?: true;
};

const ENTRY_ACTIONS: readonly EntryActionSpec[] = [
  { action: "new-file", label: <Trans>New file</Trans>, icon: FilePlus, group: "create" },
  { action: "new-folder", label: <Trans>New folder</Trans>, icon: FolderPlus, group: "create" },
  {
    action: "import-folder",
    label: <Trans>Folder…</Trans>,
    icon: Folder,
    group: "create",
    inImportMenu: true,
  },
  {
    action: "import-files",
    label: <Trans>Files…</Trans>,
    icon: Files,
    group: "create",
    inImportMenu: true,
  },
  { action: "rename", label: <Trans>Rename</Trans>, icon: Pencil, group: "manage" },
  { action: "move", label: <Trans>Move…</Trans>, icon: FolderInput, group: "manage" },
  { action: "copy", label: <Trans>Copy to…</Trans>, icon: Copy, group: "manage" },
  {
    action: "delete",
    label: <Trans>Delete</Trans>,
    icon: Trash2,
    group: "manage",
    destructive: true,
  },
];

type MenuRow =
  | { kind: "action"; spec: EntryActionSpec; startsGroup: boolean }
  | { kind: "import"; specs: EntryActionSpec[]; startsGroup: boolean };

function menuRows(allowedActions: readonly EntryAction[]): MenuRow[] {
  const specs = ENTRY_ACTIONS.filter((spec) => allowedActions.includes(spec.action));
  const rows: MenuRow[] = [];
  let previous: EntryActionSpec | undefined;
  for (const spec of specs) {
    const startsGroup = previous !== undefined && previous.group !== spec.group;
    previous = spec;
    const last = rows.at(-1);
    if (spec.inImportMenu && last?.kind === "import") last.specs.push(spec);
    else if (spec.inImportMenu) rows.push({ kind: "import", specs: [spec], startsGroup });
    else rows.push({ kind: "action", spec, startsGroup });
  }
  return rows;
}

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
  const item = (spec: EntryActionSpec) => {
    const Icon = spec.icon;
    return (
      <ContextMenuPrimitive.Item
        key={spec.action}
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
    );
  };
  return (
    <>
      {menuRows(allowedActions).map((row) => (
        <Fragment key={row.kind === "import" ? "import" : row.spec.action}>
          {row.startsGroup ? (
            <ContextMenuPrimitive.Separator className={dropdownMenuSeparatorClass} />
          ) : null}
          {row.kind === "action" ? (
            item(row.spec)
          ) : (
            <ContextMenuPrimitive.Sub>
              <ContextMenuPrimitive.SubTrigger
                className={cn(
                  dropdownRowVariants(),
                  dropdownMenuItemClass,
                  "data-[state=open]:bg-dropdown-hover",
                )}
              >
                <ImportIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <Trans>Import…</Trans>
                <ChevronRight className="ml-auto size-3.5" aria-hidden />
              </ContextMenuPrimitive.SubTrigger>
              <ContextMenuPrimitive.Portal>
                <ContextMenuPrimitive.SubContent
                  className={cn(
                    dropdownNavigationPageClass,
                    dropdownMenuContentClass,
                    "origin-(--radix-context-menu-content-transform-origin)",
                  )}
                >
                  {row.specs.map(item)}
                </ContextMenuPrimitive.SubContent>
              </ContextMenuPrimitive.Portal>
            </ContextMenuPrimitive.Sub>
          )}
        </Fragment>
      ))}
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
  const item = (spec: EntryActionSpec) => {
    const Icon = spec.icon;
    return (
      <DropdownMenuItem
        key={spec.action}
        variant={spec.destructive ? "destructive" : "default"}
        onSelect={() => onAction(spec.action)}
      >
        <Icon
          className={cn("size-3.5", !spec.destructive && "text-muted-foreground")}
          aria-hidden
        />
        {spec.label}
      </DropdownMenuItem>
    );
  };
  return menuRows(allowedActions).map((row) => (
    <Fragment key={row.kind === "import" ? "import" : row.spec.action}>
      {row.startsGroup ? <DropdownMenuSeparator /> : null}
      {row.kind === "action" ? (
        item(row.spec)
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ImportIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <Trans>Import…</Trans>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>{row.specs.map(item)}</DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </Fragment>
  ));
}
