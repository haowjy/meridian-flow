/**
 * DrillInMenu — a dropdown that browses a folder tree in place and ends in
 * actions. A folder opens inside the same menu, with a "‹ folder" row on top to
 * step back out; there are no flyouts or root heading. A divider separates
 * the tree from the actions. An action with choices opens them the same way,
 * in place of the tree.
 *
 * Document paths and placement menus supply a tree and actions. `useDrill` owns the drill
 * state (trail, back, here-marking, disabled leaves, focus after a drill) for any surface that
 * browses a tree in place; `DrillInMenuBody` draws it as Radix menu rows. Picking an entry and
 * running an action belong to the caller.
 */
import { t } from "@lingui/core/macro";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ForwardedRef,
  Fragment,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The list scrolls above the actions, which stay in reach on a long folder. */
const MENU_CLASS =
  "flex w-64 max-w-[calc(100vw-1rem)] flex-col overflow-hidden max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))]";

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
  /** A warning under the label: what the action will also do (a moved row arriving renamed). */
  note?: string | null;
  /** Selecting the action opens these in place of the tree, with a back row; `onSelect` is unused. */
  choices?: readonly DrillAction[];
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
  status?: ReactNode;
  isDisabled?: (node: DrillNode) => boolean;
  /** Lists folders alone: a destination picker has nothing to do with a file. */
  foldersOnly?: boolean;
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

export type DrillEntry = {
  node: DrillNode;
  /** On the way to where the writer is, or the folder just left. */
  here: boolean;
  disabled: boolean;
};

export type Drill = {
  /** Put on the element holding the rows, so a drill can move focus onto the new level. */
  scopeRef: RefObject<HTMLDivElement | null>;
  trail: readonly DrillNode[];
  /** The folder on screen; null at the top level. */
  folder: DrillNode | null;
  entries: readonly DrillEntry[];
  /** Replaces the trail and focuses the new level's first row. */
  drillTo: (next: readonly DrillNode[]) => void;
  enter: (node: DrillNode) => void;
  back: () => void;
  focusFirstRow: () => void;
};

/**
 * The drill-in model: the trail, the level it shows, and focus. Drilling unmounts the row that
 * held focus, so every drill moves it to the new level's first row (the back row inside a folder).
 */
export function useDrill({
  tree,
  hereIds,
  openAt,
  isDisabled,
  foldersOnly,
  rowSelector = '[role="menuitem"]',
}: Pick<DrillInMenuProps, "tree" | "hereIds" | "openAt" | "isDisabled" | "foldersOnly"> & {
  /** The focusable rows inside `scopeRef`. */
  rowSelector?: string;
}): Drill {
  const [trail, setTrail] = useState<readonly DrillNode[]>(openAt);
  const [exitedId, setExitedId] = useState<string | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const focusFirstRow = useCallback(() => {
    requestAnimationFrame(() => scopeRef.current?.querySelector<HTMLElement>(rowSelector)?.focus());
  }, [rowSelector]);
  const drillTo = (next: readonly DrillNode[]) => {
    setExitedId(next.length < trail.length ? (trail.at(-1)?.id ?? null) : null);
    setTrail(next);
    focusFirstRow();
  };
  const folder = trail.at(-1) ?? null;
  const children = tree.children(folder?.id ?? null);
  const entries = (foldersOnly ? children.filter((node) => node.folder) : children).map((node) => ({
    node,
    here:
      node.id === exitedId ||
      hereIds.includes(node.id) ||
      (node.documentId !== undefined && hereIds.includes(node.documentId)),
    disabled: isDisabled?.(node) ?? false,
  }));
  return {
    scopeRef,
    trail,
    folder,
    entries,
    drillTo,
    enter: (node) => drillTo([...trail, node]),
    back: () => drillTo(trail.slice(0, -1)),
    focusFirstRow,
  };
}

/** Mounted with the acquired source, so its first frame already has the correct trail. */
export function DrillInMenuBody({
  tree,
  hereIds,
  openAt,
  actions,
  onPick,
  status,
  isDisabled,
  foldersOnly,
  onCloseAutoFocus,
  onEscapeKeyDown,
}: Omit<DrillInMenuProps, "children" | "open" | "onOpenChange">) {
  const drill = useDrill({ tree, hereIds, openAt, isDisabled, foldersOnly });
  const { trail, folder, entries, focusFirstRow } = drill;
  const [choosingKey, setChoosingKey] = useState<string | null>(null);

  const currentActions = actions?.(trail) ?? [];
  const choosing = currentActions.find((action) => action.key === choosingKey && action.choices);
  const noteId = useId();
  const choose = (key: string | null) => {
    setChoosingKey(key);
    focusFirstRow();
  };

  const actionItem = (action: DrillAction) => (
    <Fragment key={action.key}>
      <DropdownMenuItem
        disabled={action.disabled}
        aria-describedby={action.note ? `${noteId}-${action.key}` : undefined}
        onSelect={(event) => {
          event.preventDefault();
          if (action.choices) choose(action.key);
          else action.onSelect();
        }}
      >
        <action.icon aria-hidden />
        <span className="min-w-0 flex-1 truncate">{action.label}</span>
        {action.choices ? <ChevronRight className="ml-auto" aria-hidden /> : null}
      </DropdownMenuItem>
      {action.note ? (
        <p
          id={`${noteId}-${action.key}`}
          className="mx-1 mb-1 rounded-sm border border-warning/40 bg-warning-tint px-2 py-1 text-xs text-warning-ink"
        >
          {action.note}
        </p>
      ) : null}
    </Fragment>
  );

  if (choosing?.choices) {
    return (
      <DropdownMenuContent
        ref={drill.scopeRef}
        align="start"
        className={MENU_CLASS}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            choose(null);
          }
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            choose(null);
          }}
          aria-label={t`Back from ${choosing.label}`}
        >
          <ChevronLeft aria-hidden />
          <span className="min-w-0 flex-1 truncate">{choosing.label}</span>
        </DropdownMenuItem>
        {status ? <InlineErrorRow message={status} /> : null}
        <div className="min-h-0 overflow-y-auto">{choosing.choices.map(actionItem)}</div>
      </DropdownMenuContent>
    );
  }

  return (
    <DropdownMenuContent
      ref={drill.scopeRef}
      align="start"
      className={MENU_CLASS}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && trail.length > 0) {
          event.preventDefault();
          drill.back();
        }
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={onEscapeKeyDown}
    >
      {folder ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            drill.back();
          }}
          aria-label={t`Back from ${folder.title ?? folder.name}`}
        >
          <ChevronLeft aria-hidden />
          <span className="min-w-0 flex-1 truncate">{folder.title ?? folder.name}</span>
        </DropdownMenuItem>
      ) : null}
      <div className="min-h-0 overflow-y-auto">
        {entries.map(({ node, here, disabled }) => (
          <DropdownMenuItem
            key={node.id}
            disabled={disabled}
            selected={here}
            onSelect={(event) => {
              if (node.folder) {
                event.preventDefault();
                drill.enter(node);
              } else onPick(node);
            }}
          >
            <node.icon aria-hidden />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {node.folder ? <ChevronRight className="ml-auto" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </div>
      {status ? <InlineErrorRow message={status} /> : null}
      {currentActions.length > 0 ? <DropdownMenuSeparator /> : null}
      {currentActions.map(actionItem)}
    </DropdownMenuContent>
  );
}
