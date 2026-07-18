/**
 * ContextEntryActions — right-click context menu and hover kebab button for
 * file/folder rows in the desktop context tree.
 *
 * Actions: New file / New folder (open the inline create row nested at the
 * target folder), Rename (opens inline rename row), Delete (confirms then
 * deletes). Both the right-click menu and the kebab dropdown share the same
 * action dispatch — only the trigger differs.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Ellipsis, FilePlus, FolderPlus, type LucideIcon, Pencil, Trash2 } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Fragment, useCallback, useRef, useState } from "react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

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

export type EntryActionTarget = {
  /** Display name of the entry (basename). */
  name: string;
  /** Full scheme-relative path. */
  path: string;
  kind: "file" | "dir";
};

// ─── Right-click context menu (wraps the row) ───────────────────────────────

export function ContextEntryMenu({
  children,
  onAction,
}: {
  children: React.ReactNode;
  onAction: (action: EntryAction) => void;
}) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch(onAction);
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <ContextActionItems onAction={dispatch} />
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
  onAction,
  className,
}: {
  onAction: (action: EntryAction) => void;
  className?: string;
}) {
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch(onAction);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="xs"
          aria-label={t`Actions`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
            className,
          )}
        >
          <Ellipsis aria-hidden className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        onClick={(e) => e.stopPropagation()}
        onCloseAutoFocus={onCloseAutoFocus}
        className="min-w-[8rem]"
      >
        <DropdownActionItems onAction={dispatch} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Primitive-specific renderers over the shared action specification ─────

function ContextActionItems({ onAction }: { onAction: (action: EntryAction) => void }) {
  return (
    <>
      {ENTRY_ACTIONS.map((spec, index) => {
        const Icon = spec.icon;
        const startsGroup = index > 0 && ENTRY_ACTIONS[index - 1]?.group !== spec.group;
        return (
          <Fragment key={spec.action}>
            {startsGroup ? (
              <ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
            ) : null}
            <ContextMenuPrimitive.Item
              className={cn(
                "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[disabled]:opacity-50",
                spec.destructive
                  ? "text-destructive data-[highlighted]:text-destructive"
                  : "data-[highlighted]:text-accent-foreground",
              )}
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

function DropdownActionItems({ onAction }: { onAction: (action: EntryAction) => void }) {
  return ENTRY_ACTIONS.map((spec, index) => {
    const Icon = spec.icon;
    const startsGroup = index > 0 && ENTRY_ACTIONS[index - 1]?.group !== spec.group;
    return (
      <Fragment key={spec.action}>
        {startsGroup ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          className={cn(
            "cursor-pointer gap-2 text-sm",
            spec.destructive && "text-destructive focus:text-destructive",
          )}
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
  activeThreadId,
  scheme,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
}) {
  const [target, setTarget] = useState<EntryActionTarget | null>(null);
  const mutation = useDeleteContextEntry(projectId, scheme, { activeThreadId });

  const requestDelete = useCallback((t: EntryActionTarget) => setTarget(t), []);
  const cancel = useCallback(() => setTarget(null), []);

  const confirm = useCallback(async () => {
    if (!target) return;
    try {
      await mutation.mutateAsync({ path: target.path });
    } finally {
      setTarget(null);
    }
  }, [target, mutation]);

  return { target, isPending: mutation.isPending, requestDelete, cancel, confirm };
}

export function DeleteConfirmationDialog({
  target,
  isPending,
  onCancel,
  onConfirm,
}: {
  target: EntryActionTarget | null;
  isPending: boolean;
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
