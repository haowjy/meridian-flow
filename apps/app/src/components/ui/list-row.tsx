import type { HTMLAttributes, MouseEvent, ReactElement, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

type ControlProps = Omit<
  HTMLAttributes<HTMLElement>,
  "onClick" | "className" | "style" | "aria-current" | "aria-describedby"
>;

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
  disabled,
  depth = 0,
  ref,
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
}: {
  /** `list` rows are 28px, `menu` rows 32px; a `detail` adds the second line. 44px on touch. */
  density?: "list" | "menu";
  /** Makes the control a link: a plain click calls `onOpen`, a modified click stays the browser's. */
  href?: string;
  onOpen: () => void;
  /** The value in effect, or with `"page"` the place the writer is on. */
  current?: boolean | "page";
  /** Disables the main control; the actions beside it stay live. */
  disabled?: boolean;
  /** Indent steps for a row nested under another. */
  depth?: number;
  /** The main control, when it is a button. */
  ref?: Ref<HTMLButtonElement>;
  leading?: ReactNode;
  title: ReactNode;
  /** The second line. */
  detail?: ReactNode;
  /** Right of the title: an age, a count, a model name. */
  meta?: ReactNode;
  /** A mark at the row's end, inside the control. */
  trailing?: ReactNode;
  /** Buttons beside the control; in a picker, Left and Right move between them. */
  actions?: ReactNode;
  /** Hides `actions` until the row is hovered or holds focus. Touch always shows them. */
  revealActions?: boolean;
  /** Under the row, outside its control: a failure of this row's action. */
  below?: ReactNode;
  describedBy?: string;
  /** Spread first: the row's own handler, state and classes win. */
  controlProps?: ControlProps;
  /** Must return the control itself (a Tooltip trigger `asChild`), never a wrapping element. */
  wrapControl?: (control: ReactElement) => ReactNode;
}) {
  const shared = {
    ...controlProps,
    // The list's keyboard stop, and what the frame watches to draw the ring.
    "data-list-item": true,
    "aria-current": current || undefined,
    "aria-describedby": describedBy,
    style: depth ? { paddingLeft: (density === "list" ? 6 : 8) + depth * 16 } : undefined,
    className: cn(
      "flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-left text-sm text-inherit no-underline outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
      density === "list"
        ? "min-h-7 px-1.5 py-1 [@media(hover:none)]:min-h-11 coarse:min-h-11"
        : "min-h-8 px-2 py-0.5 coarse:min-h-11 [&_svg]:size-4",
      disabled && "pointer-events-none opacity-50",
    ),
  } as const;
  const content = (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate">{title}</span>
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
  const control = href ? (
    <a
      {...shared}
      href={href}
      aria-disabled={disabled || undefined}
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
  return (
    <>
      <div
        data-selected={Boolean(current)}
        data-list-row
        className={cn(
          "group/row dropdown-focus-ring flex min-w-0 items-center rounded-md transition-colors has-[>[data-list-item]:focus-visible]:bg-ink-fill data-[selected=true]:bg-ink-fill-strong data-[selected=true]:font-medium motion-reduce:transition-none",
          !current && !disabled && "hover:bg-ink-fill",
        )}
      >
        {wrapControl ? wrapControl(control) : control}
        {actions ? (
          <span
            className={cn(
              "flex shrink-0 items-center font-normal",
              revealActions &&
                "opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 coarse:opacity-100",
            )}
          >
            {actions}
          </span>
        ) : null}
      </div>
      {below}
    </>
  );
}
