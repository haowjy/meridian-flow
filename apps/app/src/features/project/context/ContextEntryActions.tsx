/** ContextEntryActions — right-click context menu and hover kebab button for file/folder rows in the desktop context tree. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  ArchiveRestore,
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
import { Fragment, type ReactNode, useLayoutEffect, useState } from "react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  useMenuActionDispatch,
} from "@/components/ui/dropdown-menu";
import {
  dropdownMenuContentClass,
  dropdownMenuItemClass,
  dropdownMenuSeparatorClass,
  dropdownPageClass,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { cn } from "@/lib/utils";
import { contextTreeOverflowTriggerClassName } from "./context-row-geometry";
import type { DragEntry } from "./entry-drag/entry";
import {
  type SelectionGrant,
  type SelectionGroup,
  useOptionalEntrySelection,
} from "./entry-drag/selection";

// ─── Action types ────────────────────────────────────────────────────────────

export type EntryAction =
  | "new-file"
  | "new-folder"
  | "import-folder"
  | "import-files"
  | "rename"
  | "move"
  | "copy"
  | "delete"
  | "restore";

type EntryActionSpec = {
  action: EntryAction;
  label: ReactNode;
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
  { action: "restore", label: <Trans>Restore</Trans>, icon: ArchiveRestore, group: "manage" },
];

/** What every row of a selection is: one kind names it, a mix is "items". */
function selectionNoun(entries: readonly DragEntry[]): "file" | "folder" | "item" {
  const [first] = entries;
  if (!first || entries.some((entry) => entry.ref.kind !== first.ref.kind)) return "item";
  return first.ref.kind === "folder" ? "folder" : "file";
}

/**
 * The menu of a selection of two or more rows: only what acts on all of them at once, so no
 * creation and no Rename. A second ordered specification through the same renderers.
 */
function selectionActions(group: SelectionGroup): EntryActionSpec[] {
  const n = group.entries.length;
  const noun = selectionNoun(group.entries);
  const specs: EntryActionSpec[] = [];
  if (group.grants.includes("move"))
    specs.push({
      action: "move",
      icon: FolderInput,
      group: "manage",
      label:
        noun === "file"
          ? plural(n, { one: "Move # file…", other: "Move # files…" })
          : noun === "folder"
            ? plural(n, { one: "Move # folder…", other: "Move # folders…" })
            : plural(n, { one: "Move # item…", other: "Move # items…" }),
    });
  if (group.grants.includes("delete"))
    specs.push({
      action: "delete",
      icon: Trash2,
      group: "manage",
      destructive: true,
      label:
        noun === "file"
          ? plural(n, { one: "Delete # file", other: "Delete # files" })
          : noun === "folder"
            ? plural(n, { one: "Delete # folder", other: "Delete # folders" })
            : plural(n, { one: "Delete # item", other: "Delete # items" }),
    });
  if (group.grants.includes("restore"))
    specs.push({
      action: "restore",
      icon: ArchiveRestore,
      group: "manage",
      label:
        noun === "file"
          ? plural(n, { one: "Restore # file", other: "Restore # files" })
          : plural(n, { one: "Restore # item", other: "Restore # items" }),
    });
  return specs;
}

/** One row's menu, for its right-click and its ⋯ alike. */
export type EntryMenu = {
  /** The row's own actions; a row with none has no menu, even inside a selection. */
  enabled: boolean;
  items: readonly EntryActionSpec[];
  /** What a selection whose rows share no action says instead of opening empty; null otherwise. */
  empty: ReactNode;
  onOpen: () => void;
  onAction: (action: EntryAction) => void;
};

const SELECTION_GRANTS = ["move", "delete", "restore"] as const satisfies readonly SelectionGrant[];

/**
 * A row's menu. Opened on a row inside a selection of two or more, it is the selection's menu and
 * acts on all of it (`run` gets the selection's rows in screen order); opened on a row outside the
 * selection, it selects that row alone and is the row's own menu (`run` gets null). The selection
 * is read once, as the menu opens, so what it acts on is what it named. The row's actions are also
 * what it grants a selection's menu (Move, Delete, Restore; never Rename or creation).
 */
export function useEntryMenu(
  entry: DragEntry,
  actions: readonly EntryAction[],
  run: (action: EntryAction, selection: readonly DragEntry[] | null) => void,
): EntryMenu {
  const selection = useOptionalEntrySelection();
  const [group, setGroup] = useState<SelectionGroup | null>(null);
  // Joined so a caller's fresh array of the same actions doesn't re-register every render.
  const grants = SELECTION_GRANTS.filter((grant) => actions.includes(grant)).join(" ");
  useLayoutEffect(
    () => selection?.grant(entry, grants ? (grants.split(" ") as SelectionGrant[]) : []),
    [selection, entry, grants],
  );
  const items = group
    ? selectionActions(group)
    : ENTRY_ACTIONS.filter((spec) => actions.includes(spec.action));
  return {
    enabled: actions.length > 0,
    items,
    // Trash rows restore; every other list's rows move and delete.
    empty:
      group === null || items.length > 0 ? null : actions.includes("restore") ? (
        <Trans>Can't restore all of these</Trans>
      ) : (
        <Trans>Can't move or delete all of these</Trans>
      ),
    onOpen() {
      const opened = selection?.group(entry) ?? null;
      if (!opened) selection?.pick(entry);
      setGroup(opened);
    },
    onAction(action) {
      if (items.some((spec) => spec.action === action)) run(action, group?.entries ?? null);
    },
  };
}

type MenuRow =
  | { kind: "action"; spec: EntryActionSpec; startsGroup: boolean }
  | { kind: "import"; specs: EntryActionSpec[]; startsGroup: boolean };

function menuRows(specs: readonly EntryActionSpec[]): MenuRow[] {
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

// ─── Right-click context menu (wraps the row) ───────────────────────────────

export function ContextEntryMenu({ children, menu }: { children: ReactNode; menu: EntryMenu }) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const dispatchAction = (action: EntryAction) => dispatch(() => menu.onAction(action));
  if (!menu.enabled) return children;
  return (
    <ContextMenuPrimitive.Root onOpenChange={(open) => open && menu.onOpen()}>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className={cn(
            dropdownPageClass,
            dropdownMenuContentClass,
            "origin-(--radix-context-menu-content-transform-origin) [--radix-menu-content-available-height:var(--radix-context-menu-content-available-height)]",
          )}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <ContextActionItems menu={menu} onAction={dispatchAction} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

// ─── Hover kebab button + dropdown ──────────────────────────────────────────

export function EntryKebabButton({ menu, className }: { menu: EntryMenu; className?: string }) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const dispatchAction = (action: EntryAction) => dispatch(() => menu.onAction(action));
  if (!menu.enabled) return null;
  return (
    <OverflowMenu
      label={t`Actions`}
      align="start"
      onOpenChange={(open) => open && menu.onOpen()}
      onCloseAutoFocus={onCloseAutoFocus}
      triggerClassName={cn(contextTreeOverflowTriggerClassName, className)}
    >
      <DropdownActionItems menu={menu} onAction={dispatchAction} />
    </OverflowMenu>
  );
}

// ─── Primitive-specific renderers over the shared action specification ─────

function ContextActionItems({
  menu,
  onAction,
}: {
  menu: EntryMenu;
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
  if (menu.empty)
    return (
      <ContextMenuPrimitive.Item
        disabled
        className={cn(dropdownRowVariants(), dropdownMenuItemClass)}
      >
        {menu.empty}
      </ContextMenuPrimitive.Item>
    );
  return (
    <>
      {menuRows(menu.items).map((row) => (
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
                  "data-[state=open]:bg-ink-fill-strong",
                )}
              >
                <ImportIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <Trans>Import…</Trans>
                <ChevronRight className="ml-auto size-3.5" aria-hidden />
              </ContextMenuPrimitive.SubTrigger>
              <ContextMenuPrimitive.Portal>
                <ContextMenuPrimitive.SubContent
                  className={cn(
                    dropdownPageClass,
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
  menu,
  onAction,
}: {
  menu: EntryMenu;
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
  if (menu.empty) return <DropdownMenuItem disabled>{menu.empty}</DropdownMenuItem>;
  return menuRows(menu.items).map((row) => (
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
