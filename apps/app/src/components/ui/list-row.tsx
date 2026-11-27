import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, MouseEvent, ReactElement, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";
import { EntryName } from "./entry-name";
import { role } from "./roles";
import { RowContextMenu, type RowMenu, RowMenuButton } from "./row-menu";

type Density = "list" | "menu";

export function contentInset(depth: number, density: Density = "list"): number {
  return (density === "list" ? 6 : 8) + depth * 16;
}

export const ICON_SLOT_PX = 16 + 8;

type ControlProps = Omit<
  HTMLAttributes<HTMLElement>,
  "onClick" | "className" | "style" | "aria-current" | "aria-describedby"
>;

type FrameProps = Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "children"> & {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

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
    <span className={cn("flex h-5 w-4 shrink-0 items-center justify-center", role.secondary)}>
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

type ListRowProps = {
  density?: Density;
  href?: string;
  onOpen?: () => void;
  current?: boolean | "page";
  selected?: boolean;
  pointed?: boolean;
  disabled?: boolean;
  gone?: boolean;
  crossedOut?: boolean;
  depth?: number;
  ref?: Ref<HTMLButtonElement>;
  icon?: LucideIcon;
  leading?: ReactNode;
  suffix?: string;
  detail?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  notice?: ReactNode;
  actions?: ReactNode;
  revealActions?: boolean;
  below?: ReactNode;
  describedBy?: string;
  /** Spread first: the row's own handler, state and classes win. */
  controlProps?: ControlProps;
  frameProps?: FrameProps;
  /** Must return the control itself (a Tooltip trigger `asChild`), never a wrapping element. */
  wrapControl?: (control: ReactElement) => ReactNode;
} & (
  | {
      title: string;
      menu: RowMenu | undefined;
    }
  | { title: ReactNode; menu?: undefined }
);

export function ListRow({
  density = "list",
  href,
  onOpen,
  current = false,
  selected = false,
  pointed = false,
  disabled: disabledProp,
  gone = false,
  crossedOut = false,
  depth = 0,
  ref,
  icon: Icon,
  leading,
  title,
  suffix,
  detail,
  meta,
  trailing,
  notice,
  actions,
  revealActions = false,
  below,
  describedBy,
  controlProps,
  wrapControl,
  frameProps,
  menu,
}: ListRowProps) {
  const disabled = disabledProp || gone;
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
          <span
            className={cn("truncate", (gone || crossedOut) && "text-muted-foreground line-through")}
          >
            <EntryName name={title} suffix={suffix} truncate />
            {/* A link can't be pressed or selected; its name says it joined the selection. */}
            {selected && href ? <span className="sr-only">{t`, selected`}</span> : null}
          </span>
          {meta && !notice ? (
            <span className="max-w-1/2 shrink-0 truncate text-xs font-normal tabular-nums text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="truncate text-xs font-normal text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {notice ? null : trailing}
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
          onOpen?.();
        }}
      >
        {content}
      </a>
    ) : (
      <button {...shared} ref={ref} type="button" disabled={disabled} onClick={onOpen}>
        {content}
      </button>
    );
  const name = suffix ? `${String(title)}~${suffix}` : String(title);
  const frame = (
    <div
      {...frameProps}
      data-selected={Boolean(current)}
      data-list-row
      className={cn(
        "group/row dropdown-focus-ring flex min-w-0 items-center rounded-md text-sm transition-colors has-[>[data-list-item]:focus-visible]:bg-ink-fill data-[selected=true]:bg-ink-fill-strong data-[selected=true]:font-medium motion-reduce:transition-none",
        "has-[>[data-selection-run=start]]:rounded-b-none has-[>[data-selection-run=middle]]:rounded-none has-[>[data-selection-run=end]]:rounded-t-none",
        selected && !current && role.selected,
        !current && !selected && !disabled && "hover:bg-ink-fill",
        pointed && !current && !selected && "bg-ink-fill",
      )}
    >
      {wrapControl ? wrapControl(control) : control}
      {notice}
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

export function ListRowField({
  depth = 0,
  icon,
  children,
}: {
  depth?: number;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className={controlClassName("list")} style={{ paddingLeft: contentInset(depth) }}>
      <IconSlot icon={icon} />
      {children}
    </div>
  );
}

export function ListLine({
  children,
  density = "list",
  depth = 0,
  iconSlot = false,
  status = false,
}: {
  children: ReactNode;
  density?: Density;
  depth?: number;
  iconSlot?: boolean;
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
