import { Search } from "lucide-react";
import type { ComponentProps, ReactNode, Ref } from "react";

import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { Input } from "@/components/ui/input";
import { handleListKeys } from "@/components/ui/list-keys";
import { ListRow } from "@/components/ui/list-row";
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
    // biome-ignore lint/a11y/useSemanticElements: fieldset intrinsic sizing breaks the bounded results scrollport. slop-lint: allow suppression the reason is stated in this comment
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
        className="h-8 pr-2 pl-8 text-sm coarse:h-11"
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
        "app-scroll flex flex-col gap-1",
        bound === "popover" ? "max-h-72" : "min-h-0 flex-1",
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

/**
 * A picker's row: `ListRow` at menu density in the list's `<li>`. Kept under its own name
 * until every picker has landed; new code may use `ListRow` directly.
 */
export function PickerRow({
  onSelect,
  buttonProps,
  wrapButton,
  ...row
}: Omit<
  ComponentProps<typeof ListRow>,
  "density" | "href" | "onOpen" | "depth" | "revealActions" | "controlProps" | "wrapControl"
> & {
  onSelect: () => void;
  buttonProps?: ComponentProps<typeof ListRow>["controlProps"];
  wrapButton?: ComponentProps<typeof ListRow>["wrapControl"];
}) {
  return (
    <li>
      <ListRow
        {...row}
        density="menu"
        onOpen={onSelect}
        controlProps={buttonProps}
        wrapControl={wrapButton}
      />
    </li>
  );
}
