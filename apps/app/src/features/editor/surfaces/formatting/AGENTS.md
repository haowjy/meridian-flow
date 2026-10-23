# Formatting surface

The selection formatting menu and its keyboard twin. Toolbar commands stay in
`surfaces/toolbar`; this surface supplies the contextual doors, menu rendering
and selection-only behavior.

- Right-click in prose opens the menu, moving the caret to the pointer first so
  Turn into converts the block the writer aimed at.
- Selection alone raises nothing: no hover trigger, no raise-on-select. Touch
  arrives only as a `contextmenu` through the kernel ladder, never a private
  pointer timer.
- Table-cell selections belong to the table surface; never classify document
  selections a second time. In a table the menu reuses the grips' rows, never a
  third copy of the verbs.
- Cut, Copy and Paste are one shared block (`clipboard-menu.tsx`), also mounted
  by the link menu. Copy goes through the single editor clipboard boundary; no
  surface calls `navigator.clipboard` directly.
- Rows use the shared command and availability predicates; refusal copy and
  `aria-disabled` come from the toolbar command layer and chrome wrappers.
- Link opens the link surface's form, never a formatting-specific popover.
- Menus and submenus use `EditorMenu`; no private contextmenu, Escape or focus
  return.

Rungs, trigger and clipboard contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
