/**
 * The app's named looks. Every heading, group label, row, secondary line and
 * interactive fill comes from one of these roles, so re-pointing a role restyles every
 * screen at once. Call sites add layout (padding, truncation), never type or colour.
 */
export const role = {
  /** A screen's own title. */
  pageHeading: "text-xl font-semibold tracking-tight text-foreground",
  /** A heading inside a screen or dialog: a card's title, a dialog title. */
  sectionHeading: "text-base font-semibold text-foreground",
  /** The name above a group of rows: a list, a menu group, a settings section. */
  groupLabel: "text-xs font-medium uppercase tracking-caps text-muted-foreground",
  /** A group inside a named list (Other chats): quieter than the list's own name. */
  subgroupLabel: "text-xs font-medium text-muted-foreground",
  /** A row's name, and controls that read as rows. Colour is the inherited foreground. */
  row: "text-sm",
  /** The secondary colour: row icons, facts beside a name, controls at rest. */
  secondary: "text-muted-foreground",
  /** Facts beside or under a row's name: age, former place, counts. */
  rowSecondary: "text-xs text-muted-foreground",
  /** A line standing in for rows: loading, empty, no results. Callers set its inset. */
  emptyLine: "py-1.5 text-xs text-muted-foreground",

  /** Hover on a transparent row or control. Filled controls use the `interactive` layer. */
  hover: "hover:bg-ink-fill",
  /** The open row, the shown tab, the current chat or value, rows in a selection. Ink, never jade. */
  selected: "bg-ink-fill-strong",
  /** A control whose menu is open wears the selected fill. */
  open: "popup-open:bg-ink-fill-strong popup-open:text-foreground",
  /** A drag's lit target: a tab, a source, a folder with everything shown inside it. */
  dropTarget: "bg-ink-fill-strong ring-1 ring-focus ring-inset",
} as const;
