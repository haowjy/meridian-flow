/**
 * ContextEntryActions — right-click context menu and hover kebab button for
 * file/folder rows in the desktop context tree.
 *
 * Actions: New file / New folder (open the inline create row nested at the
 * target folder), Rename (opens inline rename row), Delete (confirms then
 * deletes). Both the right-click menu and the kebab dropdown share the same
 * action dispatch — only the trigger differs. Schemes without in-tree
 * creation (see `schemeAllowsCreation`) drop the create group.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { FilePlus, FolderPlus, type LucideIcon, Pencil, Trash2 } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Fragment, useCallback, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useDeleteContextEntry } from "@/client/query/useDeleteContextEntry";
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
import { useContextRemovalCoordinator } from "./ContextRemovalAccountProvider";
import { contextTreeOverflowTriggerClassName } from "./context-row-geometry";

// ─── Action types ────────────────────────────────────────────────────────────

export type EntryAction = "new-file" | "new-folder" | "rename" | "delete";

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
  {
    action: "delete",
    label: <Trans>Delete</Trans>,
    icon: Trash2,
    group: "manage",
    destructive: true,
  },
];

/**
 * Per-scheme capability filter (`schemeAllowsCreation`): schemes without
 * in-tree creation (uploads is intake only) drop the create group from both
 * menus; manage actions always show.
 */
function visibleEntryActions(allowCreate: boolean): readonly EntryActionSpec[] {
  return allowCreate ? ENTRY_ACTIONS : ENTRY_ACTIONS.filter((spec) => spec.group !== "create");
}

export type EntryActionTarget = {
  /** Display name of the entry (basename). */
  name: string;
  /** Full scheme-relative path. */
  path: string;
} & ({ kind: "file"; documentId: string } | { kind: "dir" });

type DeleteTarget = EntryActionTarget & { workId: string | null };

// ─── Right-click context menu (wraps the row) ───────────────────────────────

export function ContextEntryMenu({
  children,
  allowCreate,
  onAction,
}: {
  children: React.ReactNode;
  /** From `schemeAllowsCreation(scheme)` — hides New file / New folder. */
  allowCreate: boolean;
  onAction: (action: EntryAction) => void;
}) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch(onAction);
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
          <ContextActionItems allowCreate={allowCreate} onAction={dispatch} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/**
 * Radix menu teardown fights inline inputs for focus: selecting an item
 * closes the menu, whose focus scope reclaims focus mid-teardown and then
 * returns it to the trigger. An action that mounts an autofocusing row
 * (create/rename) would have its input blurred instantly — and blur commits
 * or cancels the row. So actions are deferred to `onCloseAutoFocus`: the
 * menu is fully closed before the action runs, and the default focus return
 * is suppressed so the row's own autofocus wins. Plain dismissal
 * (Escape/outside click) selects nothing and keeps the focus restore.
 */
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
  allowCreate,
  onAction,
  className,
  align = "start",
  sideOffset = 2,
}: {
  /** From `schemeAllowsCreation(scheme)` — hides New file / New folder. */
  allowCreate: boolean;
  onAction: (action: EntryAction) => void;
  className?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch(onAction);
  return (
    <OverflowMenu
      label={t`Actions`}
      align={align}
      sideOffset={sideOffset}
      onCloseAutoFocus={onCloseAutoFocus}
      triggerClassName={cn(contextTreeOverflowTriggerClassName, className)}
    >
      <DropdownActionItems allowCreate={allowCreate} onAction={dispatch} />
    </OverflowMenu>
  );
}

// ─── Primitive-specific renderers over the shared action specification ─────

function ContextActionItems({
  allowCreate,
  onAction,
}: {
  allowCreate: boolean;
  onAction: (action: EntryAction) => void;
}) {
  const actions = visibleEntryActions(allowCreate);
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
  allowCreate,
  onAction,
}: {
  allowCreate: boolean;
  onAction: (action: EntryAction) => void;
}) {
  const actions = visibleEntryActions(allowCreate);
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

export function useDeleteConfirmation({
  projectId,
  workId,
  scheme,
}: {
  projectId: string;
  workId: string | null;
  scheme: ProjectContextTreeScheme;
}) {
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useDeleteContextEntry(projectId, scheme);
  const contextRemoval = useContextRemovalCoordinator();
  const queryClient = useQueryClient();

  const requestDelete = useCallback(
    (t: EntryActionTarget) => {
      setError(null);
      setTarget({ ...t, workId });
    },
    [workId],
  );
  const cancel = useCallback(() => {
    setError(null);
    setTarget(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!target) return;
    setError(null);
    try {
      const locator = { scheme, path: target.path, workId: target.workId };
      const initiation = contextRemoval.captureDeleteInitiation(
        projectId,
        target.kind === "file"
          ? { kind: "file", locator, documentId: target.documentId }
          : { kind: "folder", locator },
      );
      const result = await mutation.mutateAsync(
        target.kind === "file"
          ? {
              path: target.path,
              workId: target.workId,
              expected: { kind: "file", documentId: target.documentId },
            }
          : { path: target.path, workId: target.workId, expected: { kind: "folder" } },
      );
      const admission = contextRemoval.acceptAcknowledgedDelete({
        ...initiation,
        cause: "acknowledged-delete",
        confirmed: { status: "deleted", deletedDocumentIds: result.deletedDocumentIds },
      });
      if (admission.status === "rejected") throw new Error(admission.reason);
      setTarget(null);
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextTree(
          projectId,
          scheme,
          isWorkScopedProjectContextScheme(scheme) ? target.workId : undefined,
        ),
      });
    } catch (cause) {
      // Keep the target visible so the writer can refresh and retry.
      setError(cause instanceof Error ? cause : new Error("Context deletion failed"));
    }
  }, [contextRemoval, projectId, queryClient, scheme, target, mutation]);

  return {
    target,
    isPending: mutation.isPending,
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
