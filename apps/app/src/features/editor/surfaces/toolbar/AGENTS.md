# Document toolbar

The persistent toolbar owns document-level formatting doors and the command
availability matrix. It renders controls; contextual lanes own their menus,
forms, table verbs, and object controls.

- `toolbar-commands.ts` is the single enablement and refusal predicate. A
  blocked row remains visible with shared `aria-disabled`/reason treatment;
  it must not advertise a dispatch that will refuse.
- Fixed geometry (ruling 15): ten controls, always, in one order. A control that
  cannot apply greys with its reason in the tooltip; it never disappears or
  moves as the caret travels. A pane too narrow for the row (the dock) scrolls
  it horizontally instead of dropping controls into a menu.
- Toggles reverse (law 6): Heading toggles H1 and paragraph, bullet list
  un-lists, marks remove, and the Code button fences or un-fences a block (human
  ruling: it makes a ``` block, it does not format text). Inline code and
  strikethrough are not on this row; their surface is the formatting menu, and
  the commands stay here so both share one fence.
- Block alignment resolves all alignable top-level blocks in the selection and
  applies one command. Do not classify table cells or object types in the
  component.
- The Link button opens `surfaces/link`; it is a door, not a second link form.
  Contextual controls do not migrate into this persistent row.
- Use `EditorMenu` for the alignment radio menu and the shared chrome focus and
  Escape contract. Do not add a private Radix root or focus timer.
- Writer copy and blocked reasons belong in `toolbar-copy.ts` and the compiled
  locale catalogs. Use semantic design tokens only.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for the complete reason
matrix and clipboard/close behavior.
