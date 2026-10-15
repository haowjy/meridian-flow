# Formatting surface

This directory owns the selection formatting menu and its keyboard twin.
Toolbar commands remain in `surfaces/toolbar`; this lane supplies contextual
doors, menu rendering, and selection-only behavior.

- Right-click has two rungs, one menu: `text-selection` for a sweep the pointer
  is inside, and `caret`, the ladder's floor, for every other right-click in
  prose (human ruling, 2026-07-29), which moves the caret to the pointer
  synchronously before opening so Turn into converts the block the writer aimed
  at. Code fences, objects, portalled chrome and read-only documents decline;
  link and table lanes keep their own claims. Shift+right-click is the
  kernel's, above the ladder.
- The keyboard twin (Menu key, Shift+F10) owns the selection door only: it
  declines wherever the `text-selection` rung declines and has no caret rung.
  Table-cell selections belong to the table lane; this menu must not classify
  document selections a second time.
- Selection alone raises nothing (ruling 13): no hover trigger or
  raise-on-select, which is the bubble the rebuild deleted. Touch arrives only as
  a `contextmenu` through the kernel ladder, never a private pointer timer.
- In a table the menu carries the grips' own rows (`TableCaretMenuItems`), never
  a third copy of the verbs. Cut, Copy and Paste are one shared block
  (`clipboard-menu.tsx`) that the link menu also mounts; a new clipboard row or
  refusal reason is an edit there.
- Rows use the shared command/availability predicates and remain visible when
  blocked. Refusal copy and `aria-disabled` behavior come from the toolbar
  command layer and chrome wrappers.
- Link opens the link lane's form; it does not create a formatting-specific
  link popover. Menu-to-form transitions use the chrome layer scope.
- Copy uses the single editor clipboard boundary and preserves the boundary's
  refusal result. No surface calls `navigator.clipboard` directly.
- Menus and submenus use `EditorMenu`; no private contextmenu, Escape, or focus
  return implementation is permitted.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for trigger and clipboard
contracts.
