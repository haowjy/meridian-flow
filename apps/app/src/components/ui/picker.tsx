import { Search } from "lucide-react";
import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from "react";

import {
  dropdownGroupLabelClass,
  dropdownResultsClass,
  dropdownRowContainerClass,
  dropdownRowVariants,
  dropdownSearchClass,
} from "@/components/ui/dropdown-presentation";
import { Input } from "@/components/ui/input";
import { handleListKeys } from "@/components/ui/list-keys";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";

export function Picker({
  label,
  busy,
  children,
}: {
  /** Names the list as a group. Leave it out where the surface around it already has the name. */
  label?: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset intrinsic sizing breaks the bounded results scrollport.
    <div
      role="group"
      aria-label={label}
      aria-busy={busy}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      onKeyDown={handleListKeys}
    >
      {children}
    </div>
  );
}

export function PickerSearch({
  ref,
  value,
  onChange,
  label,
  disabled,
}: {
  ref?: Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  /** The field's name and its placeholder. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative mx-2 shrink-0">
      <Search
        className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        data-list-item
        ref={ref}
        type="search"
        value={value}
        disabled={disabled}
        aria-label={label}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
        className={dropdownSearchClass}
      />
    </div>
  );
}

export function PickerResults({
  bound = "popover",
  children,
}: {
  /** `popover` caps the list's height; `fill` takes the height its container gives it. */
  bound?: "popover" | "fill";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        bound === "popover" ? dropdownResultsClass : "app-scroll min-h-0 flex-1",
      )}
    >
      {children}
    </div>
  );
}

/** The one-line state of a list or a section: loading, empty, no matches. */
export function PickerLine({ children }: { children: ReactNode }) {
  return <p className={cn("px-2", role.emptyLine)}>{children}</p>;
}

/** A run of rows. Without a label it is a plain list; state lines go above the rows. */
export function PickerSection({
  label,
  state,
  children,
}: {
  label?: string;
  /** A `PickerLine` or an error row for this section alone. */
  state?: ReactNode;
  children?: ReactNode;
}) {
  const list = <ul className="flex flex-col gap-0.5">{children}</ul>;
  if (!label && !state) return list;
  return (
    <section aria-label={label}>
      {label ? <h3 className={dropdownGroupLabelClass}>{label}</h3> : null}
      {state}
      {list}
    </section>
  );
}

export function PickerRow({
  kind = "navigation",
  current = false,
  disabled,
  onSelect,
  ref,
  leading,
  title,
  detail,
  meta,
  trailing,
  actions,
  below,
  describedBy,
  buttonProps,
  wrapButton,
}: {
  /** `navigation` is one line; `descriptive` puts `detail` under the title. */
  kind?: "navigation" | "descriptive";
  /** The value in effect, or with `"page"` the place the writer is on. */
  current?: boolean | "page";
  disabled?: boolean;
  onSelect: () => void;
  ref?: Ref<HTMLButtonElement>;
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** Right of the title: an age, a model name. */
  meta?: ReactNode;
  /** A mark at the row's end, inside the button. */
  trailing?: ReactNode;
  /** Buttons beside the row's own; Left and Right move between them. */
  actions?: ReactNode;
  /** Under the row, outside its button: a failure of this row's choice. */
  below?: ReactNode;
  describedBy?: string;
  /** Spread first: the row's own handler, state and classes win. */
  buttonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "type" | "disabled" | "onClick" | "className" | "aria-current" | "aria-describedby"
  >;
  wrapButton?: (button: ReactElement) => ReactNode;
}) {
  const oneLine = kind === "navigation";
  const button = (
    <button
      {...buttonProps}
      ref={ref}
      data-list-item
      type="button"
      disabled={disabled}
      aria-current={current || undefined}
      aria-describedby={describedBy}
      onClick={onSelect}
      className={cn(dropdownRowVariants({ kind, interactive: false }), "flex-1")}
    >
      {leading}
      {oneLine ? (
        <>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {detail ? (
            <span className="max-w-24 min-w-0 shrink-0 truncate text-xs font-medium text-muted-foreground">
              {detail}
            </span>
          ) : null}
          {meta ? <RowMeta>{meta}</RowMeta> : null}
        </>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate font-medium">{title}</span>
            {meta ? <RowMeta>{meta}</RowMeta> : null}
          </span>
          {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
        </span>
      )}
      {trailing}
    </button>
  );
  return (
    <li>
      <div
        data-selected={Boolean(current)}
        data-list-row={actions ? true : undefined}
        className={cn(
          dropdownRowContainerClass,
          "flex min-w-0 items-center transition-colors",
          !current && !disabled && "hover:bg-ink-fill",
        )}
      >
        {wrapButton ? wrapButton(button) : button}
        {actions}
      </div>
      {below}
    </li>
  );
}

function RowMeta({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-1/2 shrink-0 truncate text-xs font-normal tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}
