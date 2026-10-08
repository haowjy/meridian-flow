/**
 * DrillInMenu — a dropdown that browses a folder tree in place and ends in
 * actions. A folder opens inside the same menu, with a "‹ folder" row on top to
 * step back out; there are no flyouts. At the top level a heading names the
 * tree's source. A divider then separates the tree from the actions.
 *
 * The component takes a tree source and an action list, so the dock's
 * document title and the rail's Scratch control can share it. It owns only the
 * drill state; picking an entry and running an action belong to the caller.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactElement, type RefObject, useCallback, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type DrillNode = {
  id: string;
  name: string;
  icon: LucideIcon;
  /** A folder drills in; anything else is picked. */
  folder: boolean;
};

export type DrillTree = {
  /** Names the tree's source at the top level. */
  heading: string;
  /** What an empty top level says; a folder with nothing in it keeps the generic line. */
  empty?: string;
  /** A folder's entries in display order; `null` is the top level. */
  children: (folderId: string | null) => readonly DrillNode[];
};

export type DrillAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
};

export type DrillInMenuProps = {
  tree: DrillTree;
  /** The entry the writer is on; it is highlighted wherever it appears. */
  currentId: string | null;
  /** The folders, outermost first, the menu opens inside. */
  openAt: readonly DrillNode[];
  actions: readonly DrillAction[];
  onPick: (node: DrillNode) => void;
  /** Where focus goes when the menu closes without an action; defaults to the trigger. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Which side of the trigger the menu opens on; it flips when there is no room. */
  side?: "top" | "bottom";
  /** The trigger, rendered as the menu's anchor. */
  children: ReactElement;
};

export function DrillInMenu({
  tree,
  currentId,
  openAt,
  actions,
  onPick,
  returnFocusRef,
  side,
  children,
}: DrillInMenuProps) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<readonly DrillNode[]>(openAt);
  const contentRef = useRef<HTMLDivElement>(null);
  // An action runs after the menu has handed focus back, so what it focuses
  // (a rename field) is not pulled away by the trigger's restore.
  const pendingAction = useRef<DrillAction | null>(null);

  const changeOpen = (next: boolean) => {
    if (next) setTrail(openAt);
    setOpen(next);
  };
  const focusFirstRow = useCallback(() => {
    requestAnimationFrame(() =>
      contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
    );
  }, []);
  const drill = (next: readonly DrillNode[]) => {
    setTrail(next);
    focusFirstRow();
  };

  const folder = trail.at(-1) ?? null;
  const entries = tree.children(folder?.id ?? null);

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        side={side}
        className="w-64 max-w-[calc(100vw-1rem)]"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && trail.length > 0) {
            event.preventDefault();
            drill(trail.slice(0, -1));
          }
        }}
        onCloseAutoFocus={(event) => {
          const action = pendingAction.current;
          pendingAction.current = null;
          if (action) {
            event.preventDefault();
            action.onSelect();
          } else if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        {folder ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              drill(trail.slice(0, -1));
            }}
            aria-label={t`Back from ${folder.name}`}
          >
            <ChevronLeft aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuLabel className="truncate text-muted-foreground">
            {tree.heading}
          </DropdownMenuLabel>
        )}
        {entries.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {folder ? (
              <Trans>Nothing here yet.</Trans>
            ) : (
              (tree.empty ?? <Trans>Nothing here yet.</Trans>)
            )}
          </p>
        ) : (
          entries.map((node) => (
            <DropdownMenuItem
              key={node.id}
              aria-current={node.id === currentId ? "true" : undefined}
              className={cn(node.id === currentId && "bg-dropdown-selected font-medium")}
              onSelect={(event) => {
                if (node.folder) {
                  event.preventDefault();
                  drill([...trail, node]);
                } else onPick(node);
              }}
            >
              <node.icon aria-hidden />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.folder ? <ChevronRight className="ml-auto" aria-hidden /> : null}
            </DropdownMenuItem>
          ))
        )}
        {actions.length > 0 ? <DropdownMenuSeparator /> : null}
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            onSelect={() => {
              pendingAction.current = action;
            }}
          >
            <action.icon aria-hidden />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
