# Document toolbar

The persistent toolbar: document-level formatting doors and the command
availability matrix. It renders controls; contextual surfaces own their menus,
forms, table verbs and object controls, and none of those migrate into this
row.

- `toolbar-commands.ts` is the single enablement and refusal predicate. A
  control never advertises a dispatch that will refuse.
- Every toggle reverses: what is on can always come off.
- Components don't classify table cells or object types; the commands do.
- The Link button opens `surfaces/link`; it is a door, not a second link form.
- Use `EditorMenu` for menus and the shared chrome focus and Escape contract;
  no private Radix root or focus timer.
- Writer copy and blocked reasons live in `toolbar-copy.ts` and the compiled
  locale catalogs. Semantic design tokens only.

Current layout, the reason matrix, clipboard and close behavior:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
