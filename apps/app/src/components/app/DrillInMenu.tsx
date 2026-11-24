import { t } from "@lingui/core/macro";
import { entrySegment } from "@meridian/contracts/protocol";
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
import { EntryName } from "@/components/ui/entry-name";

const MENU_CLASS =
  "flex w-64 max-w-[calc(100vw-1rem)] flex-col overflow-hidden max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))]";

export type DrillNode = {
  id: string;
  documentId?: string;
  name: string;
  suffix?: string;
  title?: string;
  icon: LucideIcon;
  folder: boolean;
  editable?: boolean;
};

export type DrillTree = {
  heading: string;
  children: (folderId: string | null) => readonly DrillNode[];
  trailInside: (folderId: string) => readonly DrillNode[] | null;
};

export type DrillAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  note?: string | null;
  choices?: readonly DrillAction[];
};

export type DrillInMenuProps = {
  tree: DrillTree;
  hereIds: readonly string[];
  openAt: readonly DrillNode[];
  actions?: (trail: readonly DrillNode[]) => readonly DrillAction[];
  status?: ReactNode;
  isDisabled?: (node: DrillNode) => boolean;
  foldersOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPick: (node: DrillNode) => void;
  children: ReactElement;
};

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
  here: boolean;
  disabled: boolean;
};

export type Drill = {
  scopeRef: RefObject<HTMLDivElement | null>;
  trail: readonly DrillNode[];
  folder: DrillNode | null;
  entries: readonly DrillEntry[];
  enter: (node: DrillNode) => void;
  back: () => void;
  focusFirstRow: () => void;
};

export function useDrill({
  tree,
  hereIds,
  openAt,
  isDisabled,
  foldersOnly,
  rowSelector = '[role="menuitem"]',
}: Pick<DrillInMenuProps, "tree" | "hereIds" | "openAt" | "isDisabled" | "foldersOnly"> & {
  rowSelector?: string;
}): Drill {
  const [entered, setEntered] = useState<readonly string[]>(() => openAt.map((node) => node.id));
  const [exitedId, setExitedId] = useState<string | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const focusFirstRow = useCallback(() => {
    requestAnimationFrame(() => scopeRef.current?.querySelector<HTMLElement>(rowSelector)?.focus());
  }, [rowSelector]);
  const trail = (() => {
    for (const id of entered.toReversed()) {
      const live = tree.trailInside(id);
      if (live) return live;
    }
    return [];
  })();
  const drillTo = (next: readonly DrillNode[]) => {
    setExitedId(next.length < trail.length ? (trail.at(-1)?.id ?? null) : null);
    setEntered(next.map((node) => node.id));
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
    enter: (node) => drillTo([...trail, node]),
    back: () => drillTo(trail.slice(0, -1)),
    focusFirstRow,
  };
}

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
          aria-label={t`Back from ${folder.title ?? entrySegment(folder.name, folder.suffix)}`}
        >
          <ChevronLeft aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {folder.title ?? <EntryName name={folder.name} suffix={folder.suffix} truncate />}
          </span>
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
            <span className="min-w-0 flex-1 truncate">
              <EntryName name={node.name} suffix={node.suffix} truncate />
            </span>
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
