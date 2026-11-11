# surfaces/formatting

The selection formatting menu and its keyboard twin. Toolbar commands stay in
`surfaces/toolbar`.

- Selection alone raises nothing. Touch arrives only as a `contextmenu` through the kernel
  ladder, never a private pointer timer.
- Table-cell selections belong to the table surface; in a table the menu reuses the grips'
  rows, not a third copy of the verbs.
- Cut, Copy and Paste are one shared block (`clipboard-menu.tsx`), also mounted by the
  link menu.
- Add link opens the link surface's form, not a formatting-specific popover.

Rungs, the keyboard door and clipboard contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
