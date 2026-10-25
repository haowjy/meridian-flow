/**
 * DrillInMenu — a dropdown that browses a folder tree in place and ends in
 * actions. A folder opens inside the same menu, with a "‹ folder" row on top to
 * step back out; there are no flyouts or root heading. A divider separates
 * the tree from the actions.
 *
 * Document paths and placement menus supply a tree and actions. This component
 * owns only drill state; picking an entry and running an action belong to the caller.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ForwardedRef,
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type DrillNode = {
  id: string;
  /** The document a file entry opens, when it differs from `id`. */
  documentId?: string;
  name: string;
  /** What the back row says inside a folder, when that is richer than the row's name. */
  title?: string;
  icon: LucideIcon;
  /** A folder drills in; anything else is picked. */
  folder: boolean;
};

export type DrillTree = {
  /** Names the tree's source at the top level. */
  heading: string;
  /** A folder's entries in display order; `null` is the top level. */
  children: (folderId: string | null) => readonly DrillNode[];
};

export type DrillAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** A warning under the label: what the action will also do (rows arriving renamed). */
  note?: string | null;
};

export type DrillInMenuProps = {
  tree: DrillTree;
  /**
   * Where the writer is: the document and the folders that hold it. Any of them
   * listed at the level shown is highlighted, so each level marks the way back.
   */
  hereIds: readonly string[];
  /** The folders, outermost first, the menu opens inside. */
  openAt: readonly DrillNode[];
  /** Footer actions for the level on screen; the caller closes the menu when one is done. */
  actions?: (trail: readonly DrillNode[]) => readonly DrillAction[];
  caption?: ReactNode;
  status?: ReactNode;
  isDisabled?: (node: DrillNode) => boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPick: (node: DrillNode) => void;
  /** The trigger, rendered as the menu's anchor. */
  children: ReactElement;
};

/** Stable Radix trigger boundary; the browsing body and its acquisition mount only while open. */
export function DrillInMenuRoot({
  children,
  body,
  open: controlledOpen,
  onOpenChange,
  triggerProps,
  triggerRef,
}: {
  children: ReactElement;
  body: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerProps?: Omit<ComponentPropsWithoutRef<typeof DropdownMenuTrigger>, "asChild">;
  triggerRef?: ForwardedRef<HTMLButtonElement>;
}) {
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <DropdownMenuTrigger asChild {...triggerProps} ref={triggerRef}>
        {children}
      </DropdownMenuTrigger>
      {open ? body : null}
    </DropdownMenu>
  );
}

export function DrillInMenu({ children, open, onOpenChange, ...body }: DrillInMenuProps) {
  return (
    <DrillInMenuRoot open={open} onOpenChange={onOpenChange} body={<DrillInMenuBody {...body} />}>
      {children}
    </DrillInMenuRoot>
  );
}

/** Mounted with the acquired source, so its first frame already has the correct trail. */
export function DrillInMenuBody({
  tree,
  hereIds,
  openAt,
  actions,
  onPick,
  caption,
  status,
  isDisabled,
  onCloseAutoFocus,
  onEscapeKeyDown,
}: Omit<DrillInMenuProps, "children" | "open" | "onOpenChange">) {
  const [trail, setTrail] = useState<readonly DrillNode[]>(openAt);
  const [exitedId, setExitedId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusFirstRow = useCallback(() => {
    requestAnimationFrame(() =>
      contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
    );
  }, []);
  const drill = (next: readonly DrillNode[]) => {
    setExitedId(next.length < trail.length ? (trail.at(-1)?.id ?? null) : null);
    setTrail(next);
    focusFirstRow();
  };
  const isHere = (id: string) => id === exitedId || hereIds.includes(id);

  const folder = trail.at(-1) ?? null;
  const entries = tree.children(folder?.id ?? null);
  const currentActions = actions?.(trail) ?? [];
  const noteId = useId();

  return (
    <DropdownMenuContent
      ref={contentRef}
      align="start"
      className="w-64 max-w-[calc(100vw-1rem)]"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && trail.length > 0) {
          event.preventDefault();
          drill(trail.slice(0, -1));
        }
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={onEscapeKeyDown}
    >
      {caption ? <p className="px-2 py-1.5 text-xs text-muted-foreground">{caption}</p> : null}
      {folder ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            drill(trail.slice(0, -1));
          }}
          aria-label={t`Back from ${folder.title ?? folder.name}`}
        >
          <ChevronLeft aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium">{folder.title ?? folder.name}</span>
        </DropdownMenuItem>
      ) : null}
      {entries.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          <Trans>Nothing here yet.</Trans>
        </p>
      ) : (
        entries.map((node) => (
          <DropdownMenuItem
            key={node.id}
            disabled={isDisabled?.(node)}
            aria-current={isHere(node.id) ? "true" : undefined}
            className={cn(isHere(node.id) && "bg-dropdown-selected font-medium")}
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
      {status ? (
        <div role="alert" className="px-2 py-1.5 text-xs text-destructive">
          {status}
        </div>
      ) : null}
      {currentActions.length > 0 ? <DropdownMenuSeparator /> : null}
      {currentActions.map((action) => (
        <Fragment key={action.key}>
          <DropdownMenuItem
            disabled={action.disabled}
            aria-describedby={action.note ? `${noteId}-${action.key}` : undefined}
            onSelect={(event) => {
              event.preventDefault();
              action.onSelect();
            }}
          >
            <action.icon aria-hidden />
            {action.label}
          </DropdownMenuItem>
          {action.note ? (
            <p
              id={`${noteId}-${action.key}`}
              className="mx-1 mb-1 rounded-sm border border-warning-border bg-warning-bg px-2 py-1 text-xs text-warning-foreground"
            >
              {action.note}
            </p>
          ) : null}
        </Fragment>
      ))}
    </DropdownMenuContent>
  );
}
