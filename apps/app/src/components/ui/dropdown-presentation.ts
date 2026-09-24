/** Shared visual recipes for menu and picker surfaces; callers retain semantics. */
import { cva } from "class-variance-authority";

export const dropdownRowVariants = cva(
  "flex w-full min-w-0 items-center justify-start gap-2 rounded-md px-2 text-left text-sm font-normal outline-hidden select-none active:scale-100 has-[>svg]:px-2 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      kind: {
        navigation: "h-8 py-1.5 [@media(pointer:coarse)]:h-11",
        descriptive: "h-10 py-0.5 [@media(pointer:coarse)]:h-11",
        identity: "min-h-11 flex-col items-start gap-0.5 py-0.5",
      },
      interactive: {
        true: "dropdown-focus-ring transition-colors hover:bg-sidebar-accent/50 focus-visible:bg-sidebar-accent/50 data-[highlighted]:bg-sidebar-accent/50",
        false: null,
      },
      selected: { true: "bg-sidebar-accent font-medium", false: null },
    },
    defaultVariants: { kind: "navigation", interactive: true, selected: false },
  },
);

export const dropdownNavigationPageClass = "px-1 py-1";
export const dropdownPickerPageClass = "px-1 py-2";
export const dropdownPanelClass =
  "rounded-lg border border-border-subtle bg-background text-popover-foreground shadow-md dark:bg-popover";
export const dropdownGroupLabelClass = "px-2 py-1.5 text-sm font-medium text-foreground";

export const dropdownMenuContentClass = `z-50 max-h-(--radix-menu-content-available-height) min-w-[8rem] overflow-x-hidden overflow-y-auto ${dropdownPanelClass} data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95`;

export const dropdownMenuItemClass =
  "relative cursor-default data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!";

export const dropdownMenuSeparatorClass = "my-1 h-px bg-border";

export const dropdownSurfaceVariants = cva(
  `dropdown-surface flex flex-col overflow-hidden ${dropdownPanelClass}`,
  {
    variants: {
      measure: {
        compact: "[--dropdown-preferred-width:14rem]",
        identity: "[--dropdown-preferred-width:18rem]",
        catalog: "[--dropdown-preferred-width:20rem]",
      },
      page: {
        navigation: dropdownNavigationPageClass,
        picker: dropdownPickerPageClass,
      },
    },
    defaultVariants: { measure: "compact", page: "navigation" },
  },
);

export const dropdownSearchClass = "h-8 pl-8 pr-2 text-sm [@media(pointer:coarse)]:h-11";

export const dropdownResultsClass = "app-scroll max-h-64";

/** Lets a composite row own selected, hover, and descendant-focus geometry. */
export const dropdownRowContainerClass =
  "dropdown-focus-ring rounded-md has-[>:focus-visible]:bg-sidebar-accent/50 data-[selected=true]:bg-sidebar-accent data-[selected=true]:has-[>:focus-visible]:bg-sidebar-accent";
