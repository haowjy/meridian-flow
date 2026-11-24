export const role = {
  pageHeading: "text-xl font-semibold tracking-tight text-foreground",
  sectionHeading: "text-base font-semibold text-foreground",
  groupLabel: "text-xs font-medium uppercase tracking-caps text-muted-foreground",
  subgroupLabel: "text-xs font-medium text-muted-foreground",
  row: "text-sm",
  secondary: "text-muted-foreground",
  rowSecondary: "text-xs text-muted-foreground",
  emptyLine: "py-1.5 text-xs text-muted-foreground",

  hover: "hover:bg-ink-fill",
  selected: "bg-ink-fill-strong",
  open: "popup-open:bg-ink-fill-strong popup-open:text-foreground",
  dropTarget: "bg-ink-fill-strong ring-1 ring-focus ring-inset",
} as const;
