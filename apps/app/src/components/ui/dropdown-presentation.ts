/** Shared visual recipes for menu and picker surfaces; callers retain semantics. */
import { cva, type VariantProps } from "class-variance-authority";

export const dropdownRowVariants = cva(
  "focus-ring flex w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      kind: {
        navigation: "h-8 py-1.5 [@media(pointer:coarse)]:h-11",
        list: "h-8 py-1.5 [@media(pointer:coarse)]:h-11",
        descriptive: "h-10 py-0.5 [@media(pointer:coarse)]:h-11",
        identity: "min-h-11 py-0.5",
      },
      interactive: {
        true: "transition-colors hover:bg-sidebar-accent/50 focus-visible:bg-sidebar-accent/50 data-[highlighted]:bg-sidebar-accent/50",
        false: "focus-ring-none",
      },
      selected: { true: "bg-sidebar-accent", false: null },
    },
    defaultVariants: { kind: "navigation", interactive: true, selected: false },
  },
);

export type DropdownRowProps = VariantProps<typeof dropdownRowVariants>;

export const dropdownSurfaceVariants = cva(
  "flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)))] max-w-[calc(100dvw-1rem-env(safe-area-inset-left)-env(safe-area-inset-right))] flex-col overflow-hidden",
  {
    variants: {
      measure: {
        compact: "w-56",
        identity: "w-72",
        catalog: "w-80",
        "thread-list": "w-72",
      },
      page: {
        navigation: "p-1",
        picker: "p-2",
        "thread-list": "p-0",
      },
    },
    defaultVariants: { measure: "compact", page: "navigation" },
  },
);

export const dropdownSearchClass = "h-8 pl-8 pr-2 text-sm [@media(pointer:coarse)]:h-11";

export const dropdownResultsVariants = cva("app-scroll min-h-0 flex-1 overflow-y-auto", {
  variants: {
    kind: {
      picker: "max-h-64",
      "thread-list": "max-h-72",
    },
  },
  defaultVariants: { kind: "picker" },
});

export const dropdownThreadRegionVariants = cva("shrink-0", {
  variants: {
    region: {
      header: "p-2",
      results: "min-h-0 flex-1 p-1",
      footer: "p-1",
    },
  },
});
