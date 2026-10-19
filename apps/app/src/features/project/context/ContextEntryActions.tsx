/** ContextEntryActions — right-click context menu and hover kebab button for file/folder rows in the desktop context tree. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, FolderInput, FolderPlus, type LucideIcon, Pencil, Trash2 } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Fragment, useCallback, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { getContextTabs } from "@/client/stores";
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
import { useDockDocumentStore } from "../dock/dock-document-store";
import { useAccountResourceReplica, useOptionalRemovedNotices } from "./account-feature-context";
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

// ─── Delete confirmation dialog ─────────────────────────────────────────────

/**
 * The file, or the presented documents inside the folder (same scheme and
 * owner), that this delete removes. The notice store keeps marks only for
 * documents a tab or the dock presents.
 */
function ownDeletedDocumentIds(projectId: string, target: DeleteTarget): string[] {
  if (target.kind === "file") return [target.documentId];
  const folder = `${target.path.replace(/^\/+|\/+$/g, "")}/`;
  const dock = useDockDocumentStore.getState().occupant;
  const presented = [
    ...getContextTabs(projectId).tabs,
    ...(dock?.projectId === projectId ? [dock.tab] : []),
  ];
  return presented.flatMap((tab) =>
    tab.kind !== "new" &&
    tab.scheme === target.scheme &&
    (target.owner.workId == null || tab.workId === target.owner.workId) &&
    tab.rootThreadId === target.owner.rootThreadId &&
    tab.path.replace(/^\/+/, "").startsWith(folder)
      ? [tab.documentId]
      : [],
  );
}

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

  const notices = useOptionalRemovedNotices();
  const confirm = useCallback(async () => {
    if (!target) return;
    setError(null);
    // This tab's own delete closes what it presents and says nothing about it, however the removal arrives.
    const settleMark =
      notices?.markOwnRemoval(projectId, ownDeletedDocumentIds(projectId, target)) ??
      (() => undefined);
    let removed = false;
    try {
      setLocalPending(true);
      if (target.kind === "file") {
        const key = await resources.keyForDocument(projectId, target.documentId);
        if (!key) throw new Error("Document resource is unavailable");
        await resources.deleteDocument(projectId, key);
      } else {
        await resources.deleteFolder(projectId, target.entryId);
      }
      removed = true;
      setTarget(null);
    } catch (cause) {
      // Keep the target visible so the writer can refresh and retry.
      setError(cause instanceof Error ? cause : new Error("Context deletion failed"));
    } finally {
      settleMark(removed ? "removed" : "kept");
      setLocalPending(false);
    }
  }, [notices, projectId, resources, target]);

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
