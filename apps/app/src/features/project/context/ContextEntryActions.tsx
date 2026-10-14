/** ContextEntryActions — right-click context menu and hover kebab button for file/folder rows in the desktop context tree. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner } from "@meridian/contracts/protocol";
import {
  ChevronRight,
  FilePlus,
  Files,
  Folder,
  FolderOutput,
  FolderPlus,
  ImportIcon,
  type LucideIcon,
  Pencil,
  Trash2,
} from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Fragment, useCallback, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useAccountResourceReplica } from "./account-feature-context";
import { contextTreeOverflowTriggerClassName } from "./context-row-geometry";

// ─── Action types ────────────────────────────────────────────────────────────

export type EntryAction =
  | "new-file"
  | "new-folder"
  | "import-folder"
  | "import-files"
  | "rename"
  | "move"
  | "delete";

type EntryActionSpec = {
  action: EntryAction;
  label: React.ReactNode;
  icon: LucideIcon;
  group: "create" | "manage";
  destructive?: true;
  /** Shown inside the "Import…" submenu instead of at the menu's top level. */
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
  { action: "move", label: <Trans>Move…</Trans>, icon: FolderOutput, group: "manage" },
  {
    action: "delete",
    label: <Trans>Delete</Trans>,
    icon: Trash2,
    group: "manage",
    destructive: true,
  },
];

/** The menu's rows in order: actions, with the import actions gathered into one "Import…" submenu. */
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

export type DeleteTarget = EntryActionTarget & { owner: ContextOwner };

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

function ActionIcon({ spec }: { spec: EntryActionSpec }) {
  const Icon = spec.icon;
  return (
    <Icon className={cn("size-3.5", !spec.destructive && "text-muted-foreground")} aria-hidden />
  );
}

function ContextActionItems({
  allowedActions,
  onAction,
}: {
  allowedActions: readonly EntryAction[];
  onAction: (action: EntryAction) => void;
}) {
  const item = (spec: EntryActionSpec) => (
    <ContextMenuPrimitive.Item
      key={spec.action}
      data-variant={spec.destructive ? "destructive" : "default"}
      className={cn(dropdownRowVariants(), dropdownMenuItemClass)}
      onSelect={() => onAction(spec.action)}
    >
      <ActionIcon spec={spec} />
      {spec.label}
    </ContextMenuPrimitive.Item>
  );
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
  const item = (spec: EntryActionSpec) => (
    <DropdownMenuItem
      key={spec.action}
      variant={spec.destructive ? "destructive" : "default"}
      onSelect={() => onAction(spec.action)}
    >
      <ActionIcon spec={spec} />
      {spec.label}
    </DropdownMenuItem>
  );
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

// ─── Delete confirmation dialog ─────────────────────────────────────────────

export function useDeleteConfirmation({ projectId }: { projectId: string }) {
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const resources = useAccountResourceReplica();
  const [localPending, setLocalPending] = useState(false);

  const requestDelete = useCallback((t: DeleteTarget) => {
    setError(null);
    setTarget(t);
  }, []);
  const cancel = useCallback(() => {
    setError(null);
    setTarget(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!target) return;
    setError(null);
    try {
      setLocalPending(true);
      if (target.kind === "file") {
        const key = await resources.keyForDocument(projectId, target.documentId);
        if (!key) throw new Error("Document resource is unavailable");
        await resources.deleteDocument(projectId, key);
      } else {
        await resources.deleteFolder(projectId, target.entryId);
      }
      setTarget(null);
    } catch (cause) {
      // Keep the target visible so the writer can refresh and retry.
      setError(cause instanceof Error ? cause : new Error("Context deletion failed"));
    } finally {
      setLocalPending(false);
    }
  }, [projectId, resources, target]);

  return {
    target,
    isPending: localPending,
    error,
    requestDelete,
    cancel,
    confirm,
  };
}

export function DeleteConfirmationDialog({
  target,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  target: EntryActionTarget | null;
  isPending: boolean;
  error?: Error | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {target?.kind === "dir" ? <Trans>Delete folder?</Trans> : <Trans>Delete file?</Trans>}
          </DialogTitle>
          <DialogDescription>
            {target?.kind === "dir" ? (
              <Trans>
                <strong className="break-all font-semibold text-foreground">{target.name}</strong>{" "}
                and all its contents will be permanently deleted.
              </Trans>
            ) : (
              <Trans>
                <strong className="break-all font-semibold text-foreground">{target?.name}</strong>{" "}
                will be permanently deleted.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">
            {isMeridianApiError(error) && error.code === "stale_target" ? (
              <Trans>The entry changed. Refresh the tree and try again.</Trans>
            ) : (
              <Trans>Couldn't delete this entry. Try again.</Trans>
            )}
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={isPending}>
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={isPending} onClick={onConfirm}>
            {isPending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
