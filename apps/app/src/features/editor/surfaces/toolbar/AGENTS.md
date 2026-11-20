# surfaces/toolbar

The persistent document toolbar. Contextual surfaces own their menus, forms, table verbs
and object controls; none of those migrate into this row.

- `toolbar-commands.ts` is the single enablement and refusal predicate. A control never
  advertises a dispatch that will refuse, and what is on can always come off.
- A block's state reads what the editor shows: `shownState(editor.state)` for heading, code
  block and alignment (never `editor.isActive` on a node), `selectedSequence` for lists and
  quotes. In a Work's view a pending heading is what is on.
- Components don't classify table cells or object types; the commands do.
- Any surface opened here returns the caret to the editor on every close path.

Reason logic, greying and caret return: [`.context/CONTEXT.md`](.context/CONTEXT.md).
