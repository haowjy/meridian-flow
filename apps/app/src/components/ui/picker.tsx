import type { KeyboardEvent, ReactNode, Ref } from "react";

import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/utils";

export function Picker({
  label,
  busy,
  onEscape,
  ref,
  children,
}: {
  label?: string;
  busy?: boolean;
  onEscape?: () => void;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onEscape && event.key === "Escape" && event.currentTarget.contains(event.target as Node)) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    handleListKeys(event);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset intrinsic sizing breaks the bounded results scrollport. slop-lint: allow suppression the reason is stated in this comment
    <div
      ref={ref}
      role="group"
      aria-label={label}
      aria-busy={busy}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

export function PickerSearch(
  props: Omit<Parameters<typeof SearchField>[0], "listItem" | "className">,
) {
  return <SearchField {...props} listItem className="shrink-0" />;
}

export function PickerResults({
  bound = "popover",
  children,
}: {
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

export function PickerSection({
  label,
  state,
  children,
}: {
  label?: string;
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
