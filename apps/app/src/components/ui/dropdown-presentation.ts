/** Shared visual recipes for menu and picker surfaces; callers retain semantics. */
import { cva } from "class-variance-authority";

import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";

// Hover and keyboard highlight are 5% ink; the current value is 10% and keeps it under the
// pointer, so the row the keyboard is on and the current value stay distinguishable.
const dropdownRow = cva(
  "flex w-full min-w-0 items-center justify-start gap-2 rounded-md px-2 text-left text-sm font-normal outline-hidden select-none active:scale-100 has-[>svg]:px-2 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      kind: {
        navigation: "h-8 py-1.5 coarse:h-11",
        descriptive: "h-10 py-0.5 coarse:h-11",
      },
      interactive: {
        true: "dropdown-focus-ring transition-colors hover:bg-ink-fill focus-visible:bg-ink-fill data-[highlighted]:bg-ink-fill",
        false: null,
      },
      selected: {
        true: "bg-ink-fill-strong hover:bg-ink-fill-strong focus-visible:bg-ink-fill-strong data-[highlighted]:bg-ink-fill-strong",
        false: null,
      },
    },
    defaultVariants: { kind: "navigation", interactive: true, selected: false },
  },
);

/** Merged, so the current value's fill wins over the hover fill whatever the CSS order. */
export function dropdownRowVariants(props?: Parameters<typeof dropdownRow>[0]): string {
  return cn(dropdownRow(props));
}

export const dropdownPageClass = "p-1.5";
export const dropdownPanelClass =
  "rounded-lg border border-border-subtle bg-card text-foreground shadow-float";
export const dropdownGroupLabelClass = `px-2 py-1.5 ${role.groupLabel}`;

export const dropdownMenuContentClass = `z-50 max-h-(--radix-menu-content-available-height) min-w-[8rem] overflow-x-hidden overflow-y-auto ${dropdownPanelClass} data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95`;

export const dropdownMenuItemClass =
  "relative cursor-default data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/12 data-[variant=destructive]:focus:text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!";

export const dropdownMenuSeparatorClass = "my-1 h-px bg-border";

export const dropdownSurfaceVariants = cva(
  `dropdown-surface flex flex-col overflow-hidden ${dropdownPageClass} ${dropdownPanelClass}`,
  {
    variants: {
      measure: {
        compact: "[--dropdown-preferred-width:14rem]",
        identity: "[--dropdown-preferred-width:18rem]",
        catalog: "[--dropdown-preferred-width:20rem]",
      },
    },
    defaultVariants: { measure: "compact" },
  },
);
