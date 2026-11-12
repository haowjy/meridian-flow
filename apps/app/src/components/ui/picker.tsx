import { Search } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { Input } from "@/components/ui/input";
import { handleListKeys } from "@/components/ui/list-keys";
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
  onSubmit,
}: {
  ref?: Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  /** The field's name and its placeholder. */
  label: string;
  disabled?: boolean;
  /** Enter in the field: a picker whose first result is the obvious choice picks it. */
  onSubmit?: () => void;
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
        onKeyDown={
          onSubmit
            ? (event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                onSubmit();
              }
            : undefined
        }
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

/** A run of rows. Without a label it is a plain list; state lines go above the rows. */
export function PickerSection({
  label,
  state,
  children,
}: {
  label?: string;
  /** A `ListLine` or an error row for this section alone. */
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
