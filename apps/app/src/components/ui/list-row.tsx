import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, MouseEvent, ReactElement, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";
import { role } from "./roles";
import { RowContextMenu, type RowMenu, RowMenuButton } from "./row-menu";

type Density = "list" | "menu";

/** Where a row's content starts inside its control: the control's padding and the indent. */
export function contentInset(depth: number, density: Density = "list"): number {
  return (density === "list" ? 6 : 8) + depth * 16;
}

/** The leading icon's slot (`w-4`) and the gap after it. */
/** The leading icon slot and its gap: where a row with an icon starts its title. */
export const ICON_SLOT_PX = 16 + 8;

type ControlProps = Omit<
  HTMLAttributes<HTMLElement>,
  "onClick" | "className" | "style" | "aria-current" | "aria-describedby"
>;

type FrameProps = Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "children"> & {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

/** The control's box, which a row being renamed in place (`ListRowField`) shares. */
function controlClassName(density: Density): string {
  return cn(
    "flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-left text-sm text-inherit no-underline outline-none select-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
    density === "list"
      ? "min-h-7 py-1 pr-1.5 [@media(hover:none)]:min-h-11 coarse:min-h-11"
      : "min-h-8 py-0.5 pr-2 coarse:min-h-11 [&_svg]:size-4",
  );
}

function IconSlot({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={cn("flex h-7 w-4 shrink-0 items-center justify-center", role.secondary)}>
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

type ListRowProps = {
  /** `list` rows are 28px, `menu` rows 32px; a `detail` adds the second line. 44px on touch. */
  density?: Density;
  /**
   * Makes the control a link: a plain click calls `onOpen`, a modified click stays the
   * browser's. Ignored while `disabled`.
   */
  href?: string;
  onOpen: () => void;
  /** The value in effect, or with `"page"` the place the writer is on. */
  current?: boolean | "page";
  /**
   * Part of the list's selection (Ctrl/Cmd- or Shift-click): the current fill, not its weight.
   * Rows whose control carries `data-selection-run` (start, middle, end) join into one block.
   */
  selected?: boolean;
  /** Disables the main control; the actions beside it stay live. */
  disabled?: boolean;
  /** Indent steps for a row nested under another, the file tree's step. */
  depth?: number;
  /** The main control, when it is a button. */
  ref?: Ref<HTMLButtonElement>;
  /** The row's kind, in the one leading-icon slot every list shares. */
  icon?: LucideIcon;
  /** A mark before the title that is not the row's kind: a picker's glyph, a status. */
  leading?: ReactNode;
  /** The second line. */
  detail?: ReactNode;
  /** Right of the title: an age, a count, a model name. */
  meta?: ReactNode;
  /** A mark at the row's end, inside the control. */
  trailing?: ReactNode;
  /** Buttons beside the control; in a picker, Left and Right move between them. */
  actions?: ReactNode;
  /** Hides `actions` and the ⋯ until the row is hovered or holds focus. Touch always shows them. */
  revealActions?: boolean;
  /** Under the row, outside its control: a failure of this row's action. */
  below?: ReactNode;
  describedBy?: string;
  /** Spread first: the row's own handler, state and classes win. */
  controlProps?: ControlProps;
  /** On the whole row, its actions included: drop handlers, data attributes. */
  frameProps?: FrameProps;
  /** Must return the control itself (a Tooltip trigger `asChild`), never a wrapping element. */
  wrapControl?: (control: ReactElement) => ReactNode;
} & (
  | {
      title: string;
      /** The row's actions: its right-click menu and its ⋯, named "Actions for {title}". */
      menu: RowMenu | undefined;
    }
  | { title: ReactNode; menu?: undefined }
);

/**
 * A line the writer clicks in a list. The frame owns the fills and the focus ring, so the
 * whole row lights as one; the main control fills it; `actions` are buttons beside it.
 * The row has no outer margin: its list carries the inset.
 */
export function ListRow({
  density = "list",
  href,
  onOpen,
  current = false,
  selected = false,
  disabled,
  depth = 0,
  ref,
  icon: Icon,
  leading,
  title,
  detail,
  meta,
  trailing,
  actions,
  revealActions = false,
  below,
  describedBy,
  controlProps,
  wrapControl,
  frameProps,
  menu,
}: ListRowProps) {
  const shared = {
    ...controlProps,
    // The list's keyboard stop, and what the frame watches to draw the ring.
    "data-list-item": true,
    "aria-current": current || undefined,
    "aria-describedby": describedBy,
    style: { paddingLeft: contentInset(depth, density) },
    className: cn(controlClassName(density), disabled && "pointer-events-none opacity-50"),
  } as const;
  const content = (
    <>
      {Icon ? <IconSlot icon={Icon} /> : null}
      {leading}
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate">
            {title}
            {/* A link can't be pressed or selected; its name says it joined the selection. */}
            {selected && href ? <span className="sr-only">{t`, selected`}</span> : null}
          </span>
          {meta ? (
            <span className="max-w-1/2 shrink-0 truncate text-xs font-normal tabular-nums text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="truncate text-xs font-normal text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {trailing}
    </>
  );
  // A disabled row is a button: a link cannot be disabled.
  const control =
    href && !disabled ? (
      <a
        {...shared}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          onOpen();
        }}
      >
        {content}
      </a>
    ) : (
      <button {...shared} ref={ref} type="button" disabled={disabled} onClick={onOpen}>
        {content}
      </button>
    );
  // A row with a menu has a string title (the props' type).
  const name = String(title);
  const frame = (
    <div
      {...frameProps}
      data-selected={Boolean(current)}
      data-list-row
      className={cn(
        "group/row dropdown-focus-ring flex min-w-0 items-center rounded-md transition-colors has-[>[data-list-item]:focus-visible]:bg-ink-fill data-[selected=true]:bg-ink-fill-strong data-[selected=true]:font-medium motion-reduce:transition-none",
        // A run of selected rows reads as one block, rounded only at its ends.
        "has-[>[data-selection-run=start]]:rounded-b-none has-[>[data-selection-run=middle]]:rounded-none has-[>[data-selection-run=end]]:rounded-t-none",
        selected && !current && role.selected,
        !current && !selected && !disabled && "hover:bg-ink-fill",
      )}
    >
      {wrapControl ? wrapControl(control) : control}
      {actions || menu ? (
        <span
          className={cn(
            "flex shrink-0 items-center font-normal",
            revealActions &&
              "opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 coarse:opacity-100",
          )}
        >
          {actions}
          {menu ? <RowMenuButton menu={menu} label={t`Actions for ${name}`} /> : null}
        </span>
      ) : null}
    </div>
  );
  return (
    <>
      {menu ? <RowContextMenu menu={menu}>{frame}</RowContextMenu> : frame}
      {below}
    </>
  );
}

/**
 * A row whose name is being edited in place (rename, create): the field sits where the
 * row's title does, so the words don't move when editing starts.
 */
export function ListRowField({
  depth = 0,
  icon,
  children,
}: {
  depth?: number;
  icon: LucideIcon;
  /** The field. */
  children: ReactNode;
}) {
  return (
    <div className={controlClassName("list")} style={{ paddingLeft: contentInset(depth) }}>
      <IconSlot icon={icon} />
      {children}
    </div>
  );
}

/**
 * The line that stands in for a list's rows: loading, empty, no matches. Put it where the
 * rows go, inside the list's inset; its text starts where theirs would.
 */
export function ListLine({
  children,
  density = "list",
  depth = 0,
  iconSlot = false,
  status = false,
}: {
  children: ReactNode;
  /** The density of the rows it stands in for. */
  density?: Density;
  depth?: number;
  /** The list's rows lead with an icon: start after its slot. */
  iconSlot?: boolean;
  /** A state that changes while the writer waits (loading): announced when it does. */
  status?: boolean;
}) {
  return (
    <p
      role={status ? "status" : undefined}
      aria-live={status ? "polite" : undefined}
      className={cn("pr-2", role.emptyLine)}
      style={{ paddingLeft: contentInset(depth, density) + (iconSlot ? ICON_SLOT_PX : 0) }}
    >
      {children}
    </p>
  );
}
